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
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _createMakesafeJob, _markMakesafePortalReportDone } from "./index.ts";

const ROOF_CASE_ID = "00000000-0000-4000-8000-000000000911";
const ROOF_MINT_ID = "00000000-0000-4000-8000-000000000912";

// ── Minimal chainable Supabase mock ─────────────────────────────────────────
type AttendanceCycleFixture = {
  id?: string;
  job_id?: string;
  cycle_number?: number;
  attendance_cycle_id?: string | null;
  cycle_attribution?: string | null;
  [key: string]: unknown;
};

type Store = {
  details?: Record<string, any>; // makesafe_job_details by job_id
  jobs?: Record<string, any>; // jobs by id (BE-2 persisted-family fallback read)
  cycles?: AttendanceCycleFixture[];
  inserts?: Array<{ table: string; row: any }>;
  updates?: Array<{ table: string; row: any; job_id?: any }>;
};

function makeClient(store: Store) {
  store.inserts = store.inserts || [];
  store.updates = store.updates || [];
  store.cycles = store.cycles || [];
  function builder(table: string) {
    const filters: Record<string, any> = {};
    let op: "select" | "insert" | "update" | "delete" = "select";
    let updateRow: any = null;
    let insertRow: any = null;
    const resolveSingle = () => {
      if (op === "insert") {
        if (table === "makesafe_attendance_cycles") {
          return { id: "cycle-new-job-1-1", ...insertRow };
        }
        return { id: "new-job-1", ...insertRow };
      }
      if (op === "update") {
        const existing = store.details?.[filters.job_id] ?? {};
        return { ...existing, ...updateRow };
      }
      if (table === "makesafe_job_details") {
        return store.details?.[filters.job_id] ?? null;
      }
      if (table === "makesafe_attendance_cycles") {
        return (store.cycles || []).find((cycle) =>
          Object.entries(filters).every(([key, value]) => cycle[key] === value)
        ) ?? null;
      }
      if (table === "makesafe_intake_cases") {
        return filters.id === ROOF_CASE_ID
          ? {
            id: ROOF_CASE_ID,
            job_id: null,
            target_job_id: null,
            instruction_key: "builder:generic/po:roof",
            builder_wo_canonical: "BUILDER-ROOF",
            builder_po_canonical: null,
            external_ref_canonical: "BUILDER-ROOF",
          }
          : null;
      }
      if (table === "jobs") return store.jobs?.[filters.id] ?? null;
      return null;
    };
    let updateRec: { table: string; row: any; job_id?: any } | null = null;
    const b: any = {
      select: () => b,
      insert: (row: any) => {
        op = "insert";
        insertRow = row;
        store.inserts!.push({ table, row });
        if (table === "makesafe_job_details" && row?.job_id) {
          store.details = store.details || {};
          store.details[row.job_id] = { ...row };
        }
        if (table === "makesafe_attendance_cycles") {
          store.cycles!.push({ id: "cycle-new-job-1-1", ...row });
        }
        return b;
      },
      update: (row: any) => {
        op = "update";
        updateRow = row;
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
      is: () => b,
      delete: () => {
        op = "delete";
        return b;
      },
      not: () => b,
      ilike: () => b,
      limit: () => b,
      order: () => b,
      maybeSingle: () =>
        Promise.resolve({ data: resolveSingle(), error: null }),
      single: () => Promise.resolve({ data: resolveSingle(), error: null }),
      then: (res: any, rej: any) =>
        Promise.resolve({
          data: op === "update" ? [resolveSingle()] : null,
          error: null,
        }).then(res, rej),
      catch: () => Promise.resolve({ data: null, error: null }),
    };
    return b;
  }
  return {
    from: (table: string) => builder(table),
    rpc: (name: string) => {
      if (name === "bind_makesafe_roof_initial_cycle_v1") {
        const detail = store.details?.["new-job-1"];
        const cycle = {
          id: "cycle-new-job-1-1",
          job_id: "new-job-1",
          cycle_number: 1,
        };
        store.cycles!.push(cycle);
        if (detail) {
          detail.attendance_cycle_id = cycle.id;
          detail.cycle_attribution = "bound";
        }
        return Promise.resolve({
          data: {
            attendance_cycle_id: cycle.id,
            cycle_number: 1,
            cycle_created: true,
            cycle_bound: true,
          },
          error: null,
        });
      }
      return Promise.resolve({ data: "SWMS-27001", error: null });
    },
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
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}

const REPORT_TYPE_DETAIL = {
  job_id: "job-rt",
  substatus: "waiting_on_trade_report",
  report_type: "roof_report",
  external_links: [
    {
      label: "Roof report link",
      url: "https://portal.example/existing",
      kind: "roof_report",
      source: "claude",
    },
  ],
  report_received_at: null,
};

const ASSESSMENT_LINKS = [
  {
    label: "Assessment report",
    url: "https://primeeco.tech/share/assessment",
    kind: "assessment_report",
  },
  {
    label: "Photos",
    url: "https://primeeco.tech/share/photos",
    kind: "photos",
  },
  {
    label: "Scope of Works",
    url: "https://primeeco.tech/share/scope",
    kind: "scope",
  },
];

const ASSESSMENT_EVIDENCE = ASSESSMENT_LINKS.map((link) => ({
  role: link.kind,
  url: link.url,
  status: "done",
  locked: true,
  signal: "form locked/submitted",
  screenshot: `/tmp/${link.kind}.png`,
  checked_at: "2026-07-27T01:00:00Z",
}));

// ── (a) report-type job: state written, event logged, ok ────────────────────
Deno.test("portal-done: report-type job -> substatus + report_received_at written, one job_event, ok", async () => {
  const { calls, restore } = stubFetch();
  try {
    const store: Store = { details: { "job-rt": { ...REPORT_TYPE_DETAIL } } };
    const res = await _markMakesafePortalReportDone(makeClient(store), {
      job_id: "job-rt",
    });
    await flush();

    assertEquals(res.ok, true);
    assertEquals(res.already_done, false);

    const upd = store.updates!.filter((u) =>
      u.table === "makesafe_job_details"
    );
    assertEquals(upd.length, 1);
    assertEquals(upd[0].job_id, "job-rt");
    assertEquals(upd[0].row.substatus, "admin_to_send_report");
    assert(
      typeof upd[0].row.report_received_at === "string" &&
        upd[0].row.report_received_at.length > 0,
    );
    assertEquals(
      "external_links" in upd[0].row,
      false,
      "no portal_url -> external_links untouched",
    );
    // W2-C: the marker records a cycle-scoped portal-locked verification (item-14 gate input).
    assert(
      typeof upd[0].row.portal_verified_at === "string" &&
        upd[0].row.portal_verified_at.length > 0,
    );
    assertEquals(
      upd[0].row.portal_verified_cycle,
      1,
      "verification stamped for the current cycle (default 1)",
    );
    assertEquals(res.verification_recorded, true);

    const events = store.inserts!.filter((i) => i.table === "job_events");
    assertEquals(events.length, 1);
    assertEquals(events[0].row.event_type, "makesafe_portal_report_done");
    assertEquals(events[0].row.detail_json.report_on_portal, true);
    assertEquals(events[0].row.detail_json.substatus, "admin_to_send_report");
    assertEquals(events[0].row.detail_json.portal_verified, true);

    // No report/doc/invoice writes of any kind.
    assertEquals(
      store.inserts!.filter((i) => i.table !== "job_events").length,
      0,
    );
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
      details: {
        "job-normal": {
          job_id: "job-normal",
          substatus: "waiting_on_trade_report",
          report_type: null,
          external_links: [],
        },
      },
    };
    const err: any = await assertRejects(
      () =>
        _markMakesafePortalReportDone(makeClient(store), {
          job_id: "job-normal",
          report_type: "roof_report",
          is_report_type: true,
        }),
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
      () =>
        _markMakesafePortalReportDone(makeClient(store), {
          job_id: "job-missing",
        }),
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
// (portal_url here is ALREADY in external_links, so even the FIX 4 link-merge
// has nothing to write — the pure-idempotency zero-write contract.)
Deno.test("portal-done: repeat on already-marked / further-advanced job -> ok, zero writes, zero events", async () => {
  const { calls, restore } = stubFetch();
  try {
    for (
      const sub of ["admin_to_send_report", "ready_to_invoice", "complete"]
    ) {
      // Already verified for the current cycle -> the repeat is a true no-op.
      const store: Store = {
        details: {
          "job-rt": {
            ...REPORT_TYPE_DETAIL,
            substatus: sub,
            cycle_number: 1,
            portal_verified_at: "2026-07-07T00:00:00Z",
            portal_verified_cycle: 1,
          },
        },
      };
      const res = await _markMakesafePortalReportDone(makeClient(store), {
        job_id: "job-rt",
        portal_url: "https://portal.example/existing",
      });
      await flush();
      assertEquals(res.ok, true, sub);
      assertEquals(res.already_done, true, sub);
      assertEquals(res.substatus, sub, "never regresses an advanced job");
      assertEquals(
        res.verification_recorded,
        false,
        `${sub}: already verified this cycle`,
      );
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
    const upd = store.updates!.filter((u) =>
      u.table === "makesafe_job_details"
    );
    assertEquals(upd.length, 1);
    const links = upd[0].row.external_links;
    assertEquals(Array.isArray(links), true);
    assertEquals(links.length, 2, "merge, not replace");
    assertEquals(
      links[0].url,
      "https://portal.example/existing",
      "existing link survives",
    );
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
    const upd = store.updates!.filter((u) =>
      u.table === "makesafe_job_details"
    );
    assertEquals(upd.length, 1); // state still advances…
    assertEquals(
      "external_links" in upd[0].row,
      false,
      "…but external_links is not rewritten",
    );
  } finally {
    restore();
  }
});

Deno.test("portal-done: non-http(s) portal_url -> 400, zero writes", async () => {
  const { restore } = stubFetch();
  try {
    const store: Store = { details: { "job-rt": { ...REPORT_TYPE_DETAIL } } };
    const err: any = await assertRejects(
      () =>
        _markMakesafePortalReportDone(makeClient(store), {
          job_id: "job-rt",
          portal_url: "javascript:alert(1)",
        }),
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
      details: {
        "job-fam": {
          ...REPORT_TYPE_DETAIL,
          job_id: "job-fam",
          report_type: null,
        },
      },
      jobs: {
        "job-fam": {
          id: "job-fam",
          metadata: { makesafe_job_family: "roof_report" },
        },
      },
    };
    const res = await _markMakesafePortalReportDone(makeClient(store), {
      job_id: "job-fam",
    });
    await flush();

    assertEquals(res.ok, true);
    assertEquals(res.already_done, false);
    const upd = store.updates!.filter((u) =>
      u.table === "makesafe_job_details"
    );
    assertEquals(upd.length, 1);
    assertEquals(upd[0].row.substatus, "admin_to_send_report");
    assertEquals(
      upd[0].row.report_type,
      "roof_report",
      "report_type self-healed onto the detail row in the same update",
    );
    const events = store.inserts!.filter((i) => i.table === "job_events");
    assertEquals(events.length, 1);
    assertEquals(events[0].row.detail_json.report_type, "roof_report");
    assertEquals(
      events[0].row.detail_json.report_type_healed_from_family,
      true,
    );
    assertEquals(calls.length, 0);
  } finally {
    restore();
  }
});

Deno.test("BE-2 (a2): assessment_report_quote family heals to the 'assessment_report' token (approveIntakeDraft convention)", async () => {
  const { restore } = stubFetch();
  try {
    const store: Store = {
      details: {
        "job-fam": {
          ...REPORT_TYPE_DETAIL,
          job_id: "job-fam",
          report_type: null,
          external_links: ASSESSMENT_LINKS,
        },
      },
      jobs: {
        "job-fam": {
          id: "job-fam",
          metadata: { makesafe_job_family: "assessment_report_quote" },
        },
      },
    };
    const res = await _markMakesafePortalReportDone(makeClient(store), {
      job_id: "job-fam",
      portal_evidence: ASSESSMENT_EVIDENCE,
      verified_by: "chrome-devtools-axi",
    });
    await flush();
    assertEquals(res.ok, true);
    const upd = store.updates!.filter((u) =>
      u.table === "makesafe_job_details"
    );
    assertEquals(upd[0].row.report_type, "assessment_report");
    const proof = JSON.parse(upd[0].row.portal_verified_signal);
    assertEquals(proof.captures.map((capture: any) => capture.role), [
      "assessment_report",
      "photos",
      "quote",
    ]);
    assertEquals(upd[0].row.portal_verified_by, "chrome-devtools-axi");
  } finally {
    restore();
  }
});

Deno.test("assessment marker rejects a human confirmation without the typed headless triad", async () => {
  const store: Store = {
    details: {
      "job-assessment": {
        ...REPORT_TYPE_DETAIL,
        job_id: "job-assessment",
        report_type: "assessment_report",
        external_links: ASSESSMENT_LINKS,
      },
    },
  };
  const error: any = await assertRejects(
    () =>
      _markMakesafePortalReportDone(makeClient(store), {
        job_id: "job-assessment",
        portal_signal: "operator-confirmed portal locked",
      }),
    Error,
    "assessment triad is not ready",
  );
  assertEquals(error.status, 409);
  assertEquals(store.updates!.length, 0);
  assertEquals(store.inserts!.length, 0);
});

Deno.test("BE-2 (b): NON-report family + client-supplied report-type flags -> still 409, zero writes", async () => {
  const { calls, restore } = stubFetch();
  try {
    for (const family of ["general_makesafe", "temp_fence_makesafe"]) {
      const store: Store = {
        details: {
          "job-fam": {
            ...REPORT_TYPE_DETAIL,
            job_id: "job-fam",
            report_type: null,
          },
        },
        jobs: {
          "job-fam": {
            id: "job-fam",
            metadata: { makesafe_job_family: family },
          },
        },
      };
      const err: any = await assertRejects(
        () =>
          _markMakesafePortalReportDone(
            makeClient(store),
            // Client tries to smuggle report-type-ness in the body — ignored.
            {
              job_id: "job-fam",
              report_type: "roof_report",
              is_report_type: true,
              makesafe_job_family: "roof_report",
            },
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
      external_ref: "BUILDER-ROOF",
      makesafe_job_family: "roof_report",
      intake_mint_id: ROOF_MINT_ID,
      suppress_notifications: true,
    }, {
      canonicalIntakeAuthority: {
        case_id: ROOF_CASE_ID,
        mint_id: ROOF_MINT_ID,
      },
    });
    await flush();

    assertEquals(res.ok, true);
    const detailInserts = store.inserts!.filter((i) =>
      i.table === "makesafe_job_details"
    );
    assertEquals(detailInserts.length, 1);
    assertEquals(
      detailInserts[0].row.report_type,
      "roof_report",
      "forward normalisation: family persists its report_type token at creation",
    );
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
    const detailInserts = store.inserts!.filter((i) =>
      i.table === "makesafe_job_details"
    );
    assertEquals(detailInserts.length, 1);
    assertEquals(detailInserts[0].row.report_type, null);
  } finally {
    restore();
  }
});

// ── FIX 4 (ship review): idempotent path must not DISCARD a new portal_url ──
// A job advanced to admin_to_send_report via update_makesafe_substatus BEFORE
// the marker delivered the URL still gets the link stored — link-merge ONLY
// (no substatus change, no report_received_at, no event).
Deno.test("FIX4: already-marked+verified job + NEW portal_url -> link merged, nothing else written, no event", async () => {
  const { calls, restore } = stubFetch();
  try {
    // Already verified this cycle -> a late URL is a pure link-merge, no re-stamp.
    const store: Store = {
      details: {
        "job-rt": {
          ...REPORT_TYPE_DETAIL,
          substatus: "admin_to_send_report",
          cycle_number: 1,
          portal_verified_at: "2026-07-07T00:00:00Z",
          portal_verified_cycle: 1,
        },
      },
    };
    const res = await _markMakesafePortalReportDone(
      makeClient(store),
      { job_id: "job-rt", portal_url: "https://portal.example/late-url" },
    );
    await flush();

    assertEquals(res.ok, true);
    assertEquals(res.already_done, true);
    assertEquals(res.portal_link_added, true);
    assertEquals(res.verification_recorded, false);
    const upd = store.updates!.filter((u) =>
      u.table === "makesafe_job_details"
    );
    assertEquals(upd.length, 1, "exactly one link-merge update");
    const keys = Object.keys(upd[0].row).sort();
    assertEquals(
      keys,
      ["external_links", "updated_at"],
      "link-only update: no substatus, no report_received_at, no re-stamp",
    );
    assertEquals(
      upd[0].row.external_links.length,
      2,
      "existing link preserved + new one appended",
    );
    assertEquals(
      upd[0].row.external_links[1].url,
      "https://portal.example/late-url",
    );
    assertEquals(
      store.inserts!.length,
      0,
      "no event on the pure link-merge path",
    );
    assertEquals(calls.length, 0);
  } finally {
    restore();
  }
});

// ── W2-C graf-recovery: a report card that "graf" advanced to ready_to_invoice
// WITHOUT verification is not deadlocked. When an agent finally confirms the portal
// is locked, the marker stamps the verification (+ merges the URL) even though the
// card is already advanced — the only way the item-14 invoice guard can ever pass.
Deno.test("W2-C graf-recovery: advanced-but-UNVERIFIED card + marker -> verification stamped + event, no substatus regression", async () => {
  const { calls, restore } = stubFetch();
  try {
    const store: Store = {
      details: {
        "job-graf": {
          ...REPORT_TYPE_DETAIL,
          job_id: "job-graf",
          substatus: "ready_to_invoice",
          cycle_number: 1,
          portal_verified_at: null,
          portal_verified_cycle: null,
        },
      },
    };
    const res = await _markMakesafePortalReportDone(
      makeClient(store),
      {
        job_id: "job-graf",
        portal_url: "https://portal.example/late-url",
        portal_signal: "form locked/submitted, 30 of 33 answered",
      },
    );
    await flush();

    assertEquals(res.ok, true);
    assertEquals(res.already_done, true);
    assertEquals(
      res.substatus,
      "ready_to_invoice",
      "never regresses the advanced substatus",
    );
    assertEquals(res.verification_recorded, true);
    const upd = store.updates!.filter((u) =>
      u.table === "makesafe_job_details"
    );
    assertEquals(upd.length, 1);
    assert(
      typeof upd[0].row.portal_verified_at === "string" &&
        upd[0].row.portal_verified_at.length > 0,
    );
    assertEquals(upd[0].row.portal_verified_cycle, 1);
    assertEquals(
      upd[0].row.portal_verified_signal,
      "form locked/submitted, 30 of 33 answered",
    );
    assertEquals(
      "substatus" in upd[0].row,
      false,
      "no substatus write on the recovery path",
    );
    assertEquals(upd[0].row.external_links.length, 2, "late URL merged too");
    const events = store.inserts!.filter((i) => i.table === "job_events");
    assertEquals(events.length, 1);
    assertEquals(events[0].row.event_type, "makesafe_portal_verified");
    assertEquals(
      events[0].row.detail_json.recovery_of_pre_verified_advance,
      true,
    );
    assertEquals(calls.length, 0);
  } finally {
    restore();
  }
});
