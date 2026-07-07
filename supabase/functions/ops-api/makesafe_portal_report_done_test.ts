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
import { _createMakesafeJob, _markMakesafePortalReportDone } from "./index.ts";

// ── Minimal chainable Supabase mock ─────────────────────────────────────────
type Store = {
  details?: Record<string, any>; // makesafe_job_details by job_id
  jobs?: Record<string, any>; // jobs by id (BE-2 persisted-family fallback read)
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
    let insertRow: any = null;
    const resolveSingle = () => {
      if (op === "insert") return { id: "new-job-1", ...insertRow };
      if (op === "update") {
        const existing = store.details?.[filters.job_id] ?? {};
        return { ...existing, ...updateRow };
      }
      if (table === "makesafe_job_details") return store.details?.[filters.job_id] ?? null;
      if (table === "jobs") return store.jobs?.[filters.id] ?? null;
      return null;
    };
    let updateRec: { table: string; row: any; job_id?: any } | null = null;
    const b: any = {
      select: () => b,
      insert: (row: any) => { op = "insert"; insertRow = row; store.inserts!.push({ table, row }); return b; },
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
      not: () => b,
      ilike: () => b,
      limit: () => b,
      order: () => b,
      maybeSingle: () => Promise.resolve({ data: resolveSingle(), error: null }),
      single: () => Promise.resolve({ data: resolveSingle(), error: null }),
      then: (res: any, rej: any) => Promise.resolve({ data: null, error: null }).then(res, rej),
      catch: () => Promise.resolve({ data: null, error: null }),
    };
    return b;
  }
  return {
    from: (table: string) => builder(table),
    rpc: () => Promise.resolve({ data: "SWMS-27001", error: null }),
  };
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

// ── BE-2: report-family gate divergence ─────────────────────────────────────
// createMakesafeJob historically wrote jobs.metadata.makesafe_job_family but
// omitted report_type on the details insert, so a family-detected report job
// showed the portal button yet 409'd the marker.

Deno.test("BE-2 (a): persisted report family with NO detail report_type -> accepted + report_type SELF-HEALED", async () => {
  const { calls, restore } = stubFetch();
  try {
    const store: Store = {
      details: { "job-fam": { ...REPORT_TYPE_DETAIL, job_id: "job-fam", report_type: null } },
      jobs: { "job-fam": { id: "job-fam", metadata: { makesafe_job_family: "roof_report" } } },
    };
    const res = await _markMakesafePortalReportDone(makeClient(store), { job_id: "job-fam" });
    await flush();

    assertEquals(res.ok, true);
    assertEquals(res.already_done, false);
    const upd = store.updates!.filter((u) => u.table === "makesafe_job_details");
    assertEquals(upd.length, 1);
    assertEquals(upd[0].row.substatus, "admin_to_send_report");
    assertEquals(upd[0].row.report_type, "roof_report", "report_type self-healed onto the detail row in the same update");
    const events = store.inserts!.filter((i) => i.table === "job_events");
    assertEquals(events.length, 1);
    assertEquals(events[0].row.detail_json.report_type, "roof_report");
    assertEquals(events[0].row.detail_json.report_type_healed_from_family, true);
    assertEquals(calls.length, 0);
  } finally {
    restore();
  }
});

Deno.test("BE-2 (a2): assessment_report_quote family heals to the 'assessment_report' token (approveIntakeDraft convention)", async () => {
  const { restore } = stubFetch();
  try {
    const store: Store = {
      details: { "job-fam": { ...REPORT_TYPE_DETAIL, job_id: "job-fam", report_type: null } },
      jobs: { "job-fam": { id: "job-fam", metadata: { makesafe_job_family: "assessment_report_quote" } } },
    };
    const res = await _markMakesafePortalReportDone(makeClient(store), { job_id: "job-fam" });
    await flush();
    assertEquals(res.ok, true);
    const upd = store.updates!.filter((u) => u.table === "makesafe_job_details");
    assertEquals(upd[0].row.report_type, "assessment_report");
  } finally {
    restore();
  }
});

Deno.test("BE-2 (b): NON-report family + client-supplied report-type flags -> still 409, zero writes", async () => {
  const { calls, restore } = stubFetch();
  try {
    for (const family of ["general_makesafe", "temp_fence_makesafe"]) {
      const store: Store = {
        details: { "job-fam": { ...REPORT_TYPE_DETAIL, job_id: "job-fam", report_type: null } },
        jobs: { "job-fam": { id: "job-fam", metadata: { makesafe_job_family: family } } },
      };
      const err: any = await assertRejects(
        () => _markMakesafePortalReportDone(
          makeClient(store),
          // Client tries to smuggle report-type-ness in the body — ignored.
          { job_id: "job-fam", report_type: "roof_report", is_report_type: true, makesafe_job_family: "roof_report" },
        ),
        Error,
        "restricted to report-type jobs",
      );
      assertEquals(err.status, 409, family);
      assertEquals(store.updates!.length, 0, `${family}: zero writes`);
      assertEquals(store.inserts!.length, 0, `${family}: zero events`);
    }
    assertEquals(calls.length, 0);
  } finally {
    restore();
  }
});

Deno.test("BE-2 (c): createMakesafeJob with a roof_report family -> detail row carries report_type", async () => {
  const { restore } = stubFetch();
  try {
    const store: Store = { details: {}, jobs: {} };
    const res = await _createMakesafeJob(makeClient(store), {
      client_name: "Jane Client",
      site_address: "12 Example St",
      makesafe_job_family: "roof_report",
      suppress_notifications: true,
    });
    await flush();

    assertEquals(res.ok, true);
    const detailInserts = store.inserts!.filter((i) => i.table === "makesafe_job_details");
    assertEquals(detailInserts.length, 1);
    assertEquals(detailInserts[0].row.report_type, "roof_report", "forward normalisation: family persists its report_type token at creation");
  } finally {
    restore();
  }
});

Deno.test("BE-2 (c2): createMakesafeJob with a non-report family -> detail report_type stays null", async () => {
  const { restore } = stubFetch();
  try {
    const store: Store = { details: {}, jobs: {} };
    const res = await _createMakesafeJob(makeClient(store), {
      client_name: "Jane Client",
      site_address: "12 Example St",
      makesafe_job_family: "general_makesafe",
      suppress_notifications: true,
    });
    await flush();
    assertEquals(res.ok, true);
    const detailInserts = store.inserts!.filter((i) => i.table === "makesafe_job_details");
    assertEquals(detailInserts.length, 1);
    assertEquals(detailInserts[0].row.report_type, null);
  } finally {
    restore();
  }
});
