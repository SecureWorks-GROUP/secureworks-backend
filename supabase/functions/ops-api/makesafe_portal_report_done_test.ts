// B4 (makesafe-report-types) — mark_makesafe_portal_report_done marker tests.
//
// The adversarially-reviewed contract (MISSION.md, blockers 1-2 + minors):
//   - restricted SERVER-SIDE to jobs whose persisted makesafe_job_details
//     .report_type is set — a client-supplied flag is never trusted;
//   - writes STATE + EVENT ONLY: substatus 'admin_to_send_report',
//     report_received_at, optional external_links MERGE (append, not replace),
//     one job_events row. NO job_service_reports, NO docs, NO render, NO
//     invoice, NO send, NO notification — proven here as ZERO outbound fetches;
//   - idempotent: a repeat call on an already-marked (or further-advanced) job
//     returns ok with zero writes and zero duplicate events.
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _markMakesafePortalReportDone } from "./index.ts";

// ── Minimal chainable Supabase mock ─────────────────────────────────────────
type Store = {
  details?: Record<string, any>; // makesafe_job_details by job_id
  inserts?: Array<{ table: string; row: any }>;
  updates?: Array<{ table: string; row: any; job_id?: any }>;
};

function makeClient(store: Store) {
  store.inserts = store.inserts || [];
  store.updates = store.updates || [];
  function builder(table: string) {
    const filters: Record<string, any> = {};
    let op: "select" | "insert" | "update" = "select";
    let updateRow: any = null;
    const resolveSingle = () => {
      if (op === "update") {
        const existing = store.details?.[filters.job_id] ?? {};
        return { ...existing, ...updateRow };
      }
      if (table === "makesafe_job_details") return store.details?.[filters.job_id] ?? null;
      return null;
    };
    let updateRec: { table: string; row: any; job_id?: any } | null = null;
    const b: any = {
      select: () => b,
      insert: (row: any) => { op = "insert"; store.inserts!.push({ table, row }); return b; },
      update: (row: any) => {
        op = "update"; updateRow = row;
        updateRec = { table, row };
        store.updates!.push(updateRec);
        return b;
      },
      eq: (k: string, v: any) => {
        filters[k] = v;
        // .update(row).eq('job_id', …) arrives in that order — backfill the target.
        if (updateRec && k === "job_id") updateRec.job_id = v;
        return b;
      },
      limit: () => b,
      order: () => b,
      maybeSingle: () => Promise.resolve({ data: resolveSingle(), error: null }),
      single: () => Promise.resolve({ data: resolveSingle(), error: null }),
      then: (res: any, rej: any) => Promise.resolve({ data: null, error: null }).then(res, rej),
      catch: () => Promise.resolve({ data: null, error: null }),
    };
    return b;
  }
  return { from: (table: string) => builder(table) };
}

// ── fetch interception: the marker must trigger NOTHING outbound ────────────
function stubFetch() {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: any) => {
    calls.push(String(input instanceof Request ? input.url : input));
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}

const REPORT_TYPE_DETAIL = {
  job_id: "job-rt",
  substatus: "waiting_on_trade_report",
  report_type: "roof_report",
  external_links: [
    { label: "Roof report link", url: "https://portal.example/existing", kind: "roof_report", source: "claude" },
  ],
  report_received_at: null,
};

// ── (a) report-type job: state written, event logged, ok ────────────────────
Deno.test("portal-done: report-type job -> substatus + report_received_at written, one job_event, ok", async () => {
  const { calls, restore } = stubFetch();
  try {
    const store: Store = { details: { "job-rt": { ...REPORT_TYPE_DETAIL } } };
    const res = await _markMakesafePortalReportDone(makeClient(store), { job_id: "job-rt" });
    await flush();

    assertEquals(res.ok, true);
    assertEquals(res.already_done, false);

    const upd = store.updates!.filter((u) => u.table === "makesafe_job_details");
    assertEquals(upd.length, 1);
    assertEquals(upd[0].job_id, "job-rt");
    assertEquals(upd[0].row.substatus, "admin_to_send_report");
    assert(typeof upd[0].row.report_received_at === "string" && upd[0].row.report_received_at.length > 0);
    assertEquals("external_links" in upd[0].row, false, "no portal_url -> external_links untouched");

    const events = store.inserts!.filter((i) => i.table === "job_events");
    assertEquals(events.length, 1);
    assertEquals(events[0].row.event_type, "makesafe_portal_report_done");
    assertEquals(events[0].row.detail_json.report_on_portal, true);
    assertEquals(events[0].row.detail_json.substatus, "admin_to_send_report");

    // No report/doc/invoice writes of any kind.
    assertEquals(store.inserts!.filter((i) => i.table !== "job_events").length, 0);
    assertEquals(calls.length, 0, "marker must trigger zero outbound fetches");
  } finally {
    restore();
  }
});

// ── (b) NON-report-type job: rejected, ZERO writes ──────────────────────────
Deno.test("portal-done: non-report-type job -> 409, zero writes, zero events", async () => {
  const { calls, restore } = stubFetch();
  try {
    const store: Store = {
      details: { "job-normal": { job_id: "job-normal", substatus: "waiting_on_trade_report", report_type: null, external_links: [] } },
    };
    const err: any = await assertRejects(
      () => _markMakesafePortalReportDone(makeClient(store), { job_id: "job-normal", report_type: "roof_report", is_report_type: true }),
      Error,
      "restricted to report-type jobs",
    );
    assertEquals(err.status, 409);
    // The client-supplied report_type/is_report_type flags above were IGNORED —
    // only the persisted detail row counts (reviewer blocker).
    assertEquals(store.updates!.length, 0);
    assertEquals(store.inserts!.length, 0);
    assertEquals(calls.length, 0);
  } finally {
    restore();
  }
});

Deno.test("portal-done: no makesafe_job_details row -> 404, zero writes", async () => {
  const { calls, restore } = stubFetch();
  try {
    const store: Store = { details: {} };
    const err: any = await assertRejects(
      () => _markMakesafePortalReportDone(makeClient(store), { job_id: "job-missing" }),
      Error,
      "only applies to make-safe jobs",
    );
    assertEquals(err.status, 404);
    assertEquals(store.updates!.length, 0);
    assertEquals(store.inserts!.length, 0);
    assertEquals(calls.length, 0);
  } finally {
    restore();
  }
});

// ── (c) idempotent repeat: ok, no second event, no writes, no regression ────
Deno.test("portal-done: repeat on already-marked / further-advanced job -> ok, zero writes, zero events", async () => {
  const { calls, restore } = stubFetch();
  try {
    for (const sub of ["admin_to_send_report", "ready_to_invoice", "complete"]) {
      const store: Store = { details: { "job-rt": { ...REPORT_TYPE_DETAIL, substatus: sub } } };
      const res = await _markMakesafePortalReportDone(makeClient(store), { job_id: "job-rt", portal_url: "https://portal.example/p" });
      await flush();
      assertEquals(res.ok, true, sub);
      assertEquals(res.already_done, true, sub);
      assertEquals(res.substatus, sub, "never regresses an advanced job");
      assertEquals(store.updates!.length, 0, `${sub}: no writes on repeat`);
      assertEquals(store.inserts!.length, 0, `${sub}: no duplicate events`);
    }
    assertEquals(calls.length, 0);
  } finally {
    restore();
  }
});

// ── (d) external_links MERGE preserves existing entries ─────────────────────
Deno.test("portal-done: portal_url is APPENDED to external_links, existing links preserved", async () => {
  const { calls, restore } = stubFetch();
  try {
    const store: Store = { details: { "job-rt": { ...REPORT_TYPE_DETAIL } } };
    const res = await _markMakesafePortalReportDone(
      makeClient(store),
      { job_id: "job-rt", portal_url: "https://portal.example/new-report" },
    );
    await flush();

    assertEquals(res.ok, true);
    const upd = store.updates!.filter((u) => u.table === "makesafe_job_details");
    assertEquals(upd.length, 1);
    const links = upd[0].row.external_links;
    assertEquals(Array.isArray(links), true);
    assertEquals(links.length, 2, "merge, not replace");
    assertEquals(links[0].url, "https://portal.example/existing", "existing link survives");
    assertEquals(links[1].url, "https://portal.example/new-report");
    assertEquals(links[1].kind, "builder_portal");
    assertEquals(calls.length, 0);
  } finally {
    restore();
  }
});

Deno.test("portal-done: a portal_url already in external_links is not duplicated (external_links untouched)", async () => {
  const { restore } = stubFetch();
  try {
    const store: Store = { details: { "job-rt": { ...REPORT_TYPE_DETAIL } } };
    const res = await _markMakesafePortalReportDone(
      makeClient(store),
      { job_id: "job-rt", portal_url: "HTTPS://PORTAL.EXAMPLE/EXISTING" }, // case-insensitive dedupe
    );
    await flush();
    assertEquals(res.ok, true);
    const upd = store.updates!.filter((u) => u.table === "makesafe_job_details");
    assertEquals(upd.length, 1); // state still advances…
    assertEquals("external_links" in upd[0].row, false, "…but external_links is not rewritten");
  } finally {
    restore();
  }
});

Deno.test("portal-done: non-http(s) portal_url -> 400, zero writes", async () => {
  const { restore } = stubFetch();
  try {
    const store: Store = { details: { "job-rt": { ...REPORT_TYPE_DETAIL } } };
    const err: any = await assertRejects(
      () => _markMakesafePortalReportDone(makeClient(store), { job_id: "job-rt", portal_url: "javascript:alert(1)" }),
      Error,
      "http(s)",
    );
    assertEquals(err.status, 400);
    assertEquals(store.updates!.length, 0);
    assertEquals(store.inserts!.length, 0);
  } finally {
    restore();
  }
});

Deno.test("portal-done: missing job_id -> 400", async () => {
  const err: any = await assertRejects(
    () => _markMakesafePortalReportDone(makeClient({ details: {} }), {}),
    Error,
    "job_id required",
  );
  assertEquals(err.status, 400);
});
