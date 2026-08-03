// CP1 — Ops Dash calendar drag-to-reschedule (ops-dash-calendar-overhaul
// Feature 1 + the folded-forward real-crew fix from Feature 2).
// ---------------------------------------------------------------------------
//   Real-crew   createAssignment REFUSES a null user_id for crew work (install
//               etc): Trade myJobs filters .eq('user_id', userId), so a
//               name-only row is invisible to everyone. Meetings/reminders are
//               planning entries and keep their existing shape (Feature 3).
//   Round-trip  updateAssignment's allowed-map carries duration_days alongside
//               scheduled_date/scheduled_end, so a drag/resize preserves the
//               working-day span length. createAssignment passes it through on
//               a reassign-recreate.
//   SMS         The NEW install_rescheduled trigger renders Shaun's approved
//               wording verbatim — "[day] the [date] of [month]", street name
//               only, no cross-sell footer — and dedups against the MOST
//               RECENT successfully-sent reschedule only: a double-tap on the
//               same drop is swallowed, but an A→B→A sequence re-sends for the
//               return to A and a failed send never blocks a retry.
// All sends are asserted against a stubbed globalThis.fetch: nothing in this
// file (or the code under test, run this way) touches a live channel.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createAssignment,
  formatDayDateMonth,
  sendClientUpdate,
  streetFromAddress,
  updateAssignment,
} from "./index.ts";

// ── Minimal chainable Supabase mock (shape follows m3c_calendar_ops_test.ts) ──
type Row = Record<string, any>;
type Store = {
  jobs?: Record<string, Row>;
  assignments?: Record<string, Row>;
  users?: Record<string, Row>;
  emailEvents?: Row[];
  inserts?: Array<{ table: string; row: Row }>;
  updates?: Array<{ table: string; row: Row }>;
};
function makeClient(store: Store) {
  store.emailEvents = store.emailEvents || [];
  store.inserts = store.inserts || [];
  store.updates = store.updates || [];
  function builder(table: string) {
    const filters: Record<string, any> = {};
    let op: "select" | "insert" | "update" | "delete" = "select";
    let payload: any = null;
    let orderKey: string | null = null;
    let orderAsc = true;
    let limitN: number | null = null;
    const resolveSingle = () => {
      if (op === "insert") return { id: "new-row", ...payload };
      if (op === "update") {
        const base = (table === "job_assignments"
          ? store.assignments?.[filters.id]
          : null) || { id: filters.id };
        return { ...base, ...payload };
      }
      if (table === "jobs") return store.jobs?.[filters.id] ?? null;
      if (table === "job_assignments") {
        return store.assignments?.[filters.id] ?? null;
      }
      if (table === "users") return store.users?.[filters.id] ?? null;
      return null;
    };
    const b: any = {
      select: () => b,
      insert: (row: Row) => {
        op = "insert";
        payload = row;
        store.inserts!.push({ table, row });
        if (table === "email_events") store.emailEvents!.push(row);
        return b;
      },
      update: (row: Row) => {
        op = "update";
        payload = row;
        store.updates!.push({ table, row });
        return b;
      },
      delete: () => {
        op = "delete";
        return b;
      },
      eq: (k: string, v: any) => {
        filters[k] = v;
        return b;
      },
      neq: () => b,
      not: () => b,
      in: () => b,
      or: () => b,
      gte: () => b,
      lte: () => b,
      lt: () => b,
      is: () => b,
      ilike: () => b,
      order: (k: string, opts?: { ascending?: boolean }) => {
        orderKey = k;
        orderAsc = opts?.ascending !== false;
        return b;
      },
      limit: (n: number) => {
        limitN = n;
        return b;
      },
      maybeSingle: () =>
        Promise.resolve({ data: resolveSingle(), error: null }),
      single: () => Promise.resolve({ data: resolveSingle(), error: null }),
      then: (res: any, rej: any) => {
        // Both dedup shapes await the builder itself: the once-per-job count
        // query AND install_rescheduled's most-recent-sent lookup (filters +
        // order desc + limit 1). Emulate both against the rows this mock has
        // actually inserted; ties on the order key resolve to latest-inserted
        // first when descending.
        if (op === "select" && table === "email_events") {
          const matched = store.emailEvents!
            .map((r, i) => ({ r, i }))
            .filter(({ r }) =>
              Object.entries(filters).every(([k, v]) => r[k] === v)
            );
          if (orderKey) {
            matched.sort((a, b2) => {
              const av = String(a.r[orderKey!] ?? "");
              const bv = String(b2.r[orderKey!] ?? "");
              const cmp = av < bv ? -1 : av > bv ? 1 : a.i - b2.i;
              return orderAsc ? cmp : -cmp;
            });
          }
          let data = matched.map(({ r }) => r);
          if (limitN != null) data = data.slice(0, limitN);
          return Promise.resolve({ count: matched.length, data, error: null })
            .then(res, rej);
        }
        return Promise.resolve({ data: [], error: null, count: 0 }).then(
          res,
          rej,
        );
      },
      catch: () => Promise.resolve({ data: null, error: null }),
    };
    return b;
  }
  return { from: (t: string) => builder(t) };
}

type FetchCall = { url: string; init?: any };
function stubFetch(opts: { failSms?: boolean; inbandFailSms?: boolean } = {}) {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    if (opts.failSms && url.includes("send_sms")) {
      return Promise.reject(new Error("GHL unreachable"));
    }
    if (opts.inbandFailSms && url.includes("send_sms")) {
      // ghl-proxy's send_sms failure shape: HTTP 200 with success:false.
      return Promise.resolve(
        new Response(
          JSON.stringify({ success: false, error: "GHL API error" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return {
    calls,
    opts,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}
const smsCalls = (calls: FetchCall[]) =>
  calls.filter((c) => c.url.includes("ghl-proxy?action=send_sms"));

function baseStore(): Store {
  return {
    jobs: {
      "job-1": {
        id: "job-1",
        type: "fencing",
        job_number: "SWF-100",
        status: "processing",
        client_name: "Jane Citizen",
        client_phone: "+61400000000",
        client_email: null,
        site_address: "12 Example St, Padbury WA 6025",
        site_suburb: "Padbury",
        ghl_contact_id: "ghl-abc",
        ghl_opportunity_id: null,
      },
    },
    users: { "inst-1": { id: "inst-1", name: "Hugo", phone: "+61400111222" } },
    assignments: {
      "a-1": {
        id: "a-1",
        job_id: "job-1",
        user_id: "inst-1",
        confirmation_status: "tentative",
        scheduled_date: "2026-07-20",
        scheduled_end: "2026-07-21",
        duration_days: 2,
        crew_name: "Hugo",
      },
    },
  };
}

// ── Real-crew guard (folded-forward Feature 2 fix) ─────────────────────────
Deno.test("real-crew: createAssignment REJECTS a null user_id for an install (clear 400 message)", async () => {
  const { restore } = stubFetch();
  try {
    const store = baseStore();
    await assertRejects(
      () =>
        createAssignment(makeClient(store), {
          jobId: "job-1",
          scheduledDate: "2026-07-27",
          crewName: "Somebody Typed",
          assignmentType: "install",
          confirmationStatus: "tentative",
        }),
      Error,
      "real crew member",
    );
    // Guard fires before any write.
    assertEquals(
      store.inserts!.filter((i) => i.table === "job_assignments").length,
      0,
    );
  } finally {
    restore();
  }
});

Deno.test("real-crew: default assignment_type (install) with no user_id also rejects", async () => {
  const { restore } = stubFetch();
  try {
    await assertRejects(
      () =>
        createAssignment(makeClient(baseStore()), {
          jobId: "job-1",
          scheduledDate: "2026-07-27",
        }),
      Error,
      "real crew member",
    );
  } finally {
    restore();
  }
});

Deno.test("real-crew: meeting/reminder planning entries keep the existing null-user shape", async () => {
  const { calls, restore } = stubFetch();
  try {
    const store = baseStore();
    const res = await createAssignment(makeClient(store), {
      jobId: "job-1",
      scheduledDate: "2026-07-27",
      assignmentType: "meeting",
      label: "Team meeting",
      confirmationStatus: "tentative",
    });
    assertEquals(res.assignment.user_id, null);
    assertEquals(smsCalls(calls).length, 0); // planning entry never texts
  } finally {
    restore();
  }
});

Deno.test("real-crew: install WITH a user_id writes the row and passes duration_days through", async () => {
  const { calls, restore } = stubFetch();
  try {
    const store = baseStore();
    const res = await createAssignment(makeClient(store), {
      jobId: "job-1",
      userId: "inst-1",
      scheduledDate: "2026-07-27",
      scheduledEnd: "2026-07-29",
      durationDays: 3,
      crewName: "Hugo",
      confirmationStatus: "tentative",
    });
    assertEquals(res.assignment.user_id, "inst-1");
    assertEquals(res.assignment.duration_days, 3);
    assertEquals(res.assignment.scheduled_end, "2026-07-29");
    assertEquals(smsCalls(calls).length, 0); // tentative planning stays silent
  } finally {
    restore();
  }
});

Deno.test("real-crew: duration_days omitted -> column left to its DB default (not written)", async () => {
  const { restore } = stubFetch();
  try {
    const store = baseStore();
    await createAssignment(makeClient(store), {
      jobId: "job-1",
      userId: "inst-1",
      scheduledDate: "2026-07-27",
      confirmationStatus: "tentative",
    });
    const row = store.inserts!.find((i) => i.table === "job_assignments")!.row;
    assert(
      !("duration_days" in row),
      "duration_days must not be written when the caller omits it",
    );
  } finally {
    restore();
  }
});

// ── Drag/resize round-trip through update_assignment ───────────────────────
Deno.test("round-trip: updateAssignment carries scheduled_date + scheduled_end + duration_days together", async () => {
  const { restore } = stubFetch();
  try {
    const store = baseStore();
    const res = await updateAssignment(makeClient(store), {
      assignmentId: "a-1",
      crew_name: "Hugo",
      scheduled_date: "2026-07-22",
      scheduled_end: "2026-07-24",
      duration_days: 3,
    });
    const upd = store.updates!.find((u) => u.table === "job_assignments")!.row;
    assertEquals(upd, {
      crew_name: "Hugo",
      scheduled_date: "2026-07-22",
      scheduled_end: "2026-07-24",
      duration_days: 3,
    });
    assertEquals(res.assignment.duration_days, 3);
  } finally {
    restore();
  }
});

Deno.test("round-trip: camelCase durationDays maps to duration_days too", async () => {
  const { restore } = stubFetch();
  try {
    const store = baseStore();
    await updateAssignment(makeClient(store), {
      assignmentId: "a-1",
      durationDays: 4,
    });
    const upd = store.updates!.find((u) => u.table === "job_assignments")!.row;
    assertEquals(upd, { duration_days: 4 });
  } finally {
    restore();
  }
});

Deno.test("round-trip: updateAssignment drops non-positive/non-numeric duration_days instead of writing them", async () => {
  const { restore } = stubFetch();
  try {
    for (const bad of [0, -2, 0.4, "abc"]) {
      const store = baseStore();
      await updateAssignment(makeClient(store), {
        assignmentId: "a-1",
        scheduled_date: "2026-07-22",
        duration_days: bad,
      });
      const upd = store.updates!.find((u) =>
        u.table === "job_assignments"
      )!.row;
      assertEquals(upd, { scheduled_date: "2026-07-22" });
    }
  } finally {
    restore();
  }
});

Deno.test("round-trip: updateAssignment rounds fractional duration_days to a positive integer", async () => {
  const { restore } = stubFetch();
  try {
    const store = baseStore();
    await updateAssignment(makeClient(store), {
      assignmentId: "a-1",
      duration_days: 2.6,
    });
    const upd = store.updates!.find((u) => u.table === "job_assignments")!.row;
    assertEquals(upd, { duration_days: 3 });
  } finally {
    restore();
  }
});

Deno.test("real-crew: createAssignment rounds before the positive check — 0.4 never writes duration_days 0", async () => {
  const { restore } = stubFetch();
  try {
    const store = baseStore();
    await createAssignment(makeClient(store), {
      jobId: "job-1",
      userId: "inst-1",
      scheduledDate: "2026-07-27",
      durationDays: 0.4,
      confirmationStatus: "tentative",
    });
    const row = store.inserts!.find((i) => i.table === "job_assignments")!.row;
    assert(
      !("duration_days" in row),
      "a value that rounds to 0 must not be written",
    );
  } finally {
    restore();
  }
});

// ── install_rescheduled trigger ────────────────────────────────────────────
const EXPECTED_SMS = "Hi Jane,\n" +
  "Hope you're well! Just letting you know we've got your fence install rescheduled for Thursday the 2nd of July at Example St. Our crew will be out between 7-10am to get it done. They'll be in contact with you closer to the day.\n" +
  "Let us know if you have any questions.\n" +
  "Cheers, Shaun";

Deno.test("install_rescheduled: renders Shaun's wording verbatim — day-the-date-of-month, street only, no footer", async () => {
  const { calls, restore } = stubFetch();
  try {
    const store = baseStore();
    const res = await sendClientUpdate(makeClient(store), {
      job_id: "job-1",
      comms_trigger: "install_rescheduled",
      template_vars: { new_date: "2026-07-02" },
    });
    assertEquals(res.sent, true);
    assertEquals(res.channel, "sms");
    const sms = smsCalls(calls);
    assertEquals(sms.length, 1);
    const body = JSON.parse(sms[0].init.body);
    assertEquals(body.contactId, "ghl-abc");
    assertEquals(body.message, EXPECTED_SMS); // exact — including NO cross-sell footer
  } finally {
    restore();
  }
});

Deno.test("install_rescheduled: dedup is per (job, new date) — double-tap swallowed, re-reschedule to a new date sends", async () => {
  const { calls, restore } = stubFetch();
  try {
    const store = baseStore();
    const client = makeClient(store);
    const first = await sendClientUpdate(client, {
      job_id: "job-1",
      comms_trigger: "install_rescheduled",
      template_vars: { new_date: "2026-07-02" },
    });
    assertEquals(first.sent, true);
    const dup = await sendClientUpdate(client, {
      job_id: "job-1",
      comms_trigger: "install_rescheduled",
      template_vars: { new_date: "2026-07-02" },
    });
    assertEquals(dup.sent, false);
    assertStringIncludes(dup.reason, "job and date");
    const again = await sendClientUpdate(client, {
      job_id: "job-1",
      comms_trigger: "install_rescheduled",
      template_vars: { new_date: "2026-07-06" },
    });
    assertEquals(again.sent, true);
    assertEquals(smsCalls(calls).length, 2);
  } finally {
    restore();
  }
});

Deno.test("install_rescheduled: A→B→A re-sends for the return to A (most recent SENT row carries B)", async () => {
  const { calls, restore } = stubFetch();
  try {
    const client = makeClient(baseStore());
    const a1 = await sendClientUpdate(client, {
      job_id: "job-1",
      comms_trigger: "install_rescheduled",
      template_vars: { new_date: "2026-07-02" },
    });
    assertEquals(a1.sent, true);
    const b = await sendClientUpdate(client, {
      job_id: "job-1",
      comms_trigger: "install_rescheduled",
      template_vars: { new_date: "2026-07-06" },
    });
    assertEquals(b.sent, true);
    const a2 = await sendClientUpdate(client, {
      job_id: "job-1",
      comms_trigger: "install_rescheduled",
      template_vars: { new_date: "2026-07-02" },
    });
    assertEquals(a2.sent, true);
    assertEquals(smsCalls(calls).length, 3);
    const dup = await sendClientUpdate(client, {
      job_id: "job-1",
      comms_trigger: "install_rescheduled",
      template_vars: { new_date: "2026-07-02" },
    });
    assertEquals(dup.sent, false);
    assertStringIncludes(dup.reason, "job and date");
  } finally {
    restore();
  }
});

Deno.test("install_rescheduled: a failed send never blocks the operator's retry", async () => {
  const stub = stubFetch({ failSms: true });
  try {
    const store = baseStore();
    const client = makeClient(store);
    const failed = await sendClientUpdate(client, {
      job_id: "job-1",
      comms_trigger: "install_rescheduled",
      template_vars: { new_date: "2026-07-02" },
    });
    assertEquals(failed.sent, false);
    assertEquals(
      store.emailEvents!.filter((r) =>
        r.comms_trigger === "install_rescheduled" && r.status === "failed"
      ).length,
      1,
    );
    stub.opts.failSms = false;
    const retry = await sendClientUpdate(client, {
      job_id: "job-1",
      comms_trigger: "install_rescheduled",
      template_vars: { new_date: "2026-07-02" },
    });
    assertEquals(retry.sent, true);
    const dup = await sendClientUpdate(client, {
      job_id: "job-1",
      comms_trigger: "install_rescheduled",
      template_vars: { new_date: "2026-07-02" },
    });
    assertEquals(dup.sent, false);
  } finally {
    stub.restore();
  }
});

Deno.test("install_rescheduled: an in-band GHL failure (HTTP 200 success:false) records failed and never blocks the retry", async () => {
  const stub = stubFetch({ inbandFailSms: true });
  try {
    const store = baseStore();
    const client = makeClient(store);
    const failed = await sendClientUpdate(client, {
      job_id: "job-1",
      comms_trigger: "install_rescheduled",
      template_vars: { new_date: "2026-07-02" },
    });
    assertEquals(failed.sent, false);
    assertEquals(
      store.emailEvents!.filter((r) =>
        r.comms_trigger === "install_rescheduled" && r.status === "failed"
      ).length,
      1,
    );
    stub.opts.inbandFailSms = false;
    const retry = await sendClientUpdate(client, {
      job_id: "job-1",
      comms_trigger: "install_rescheduled",
      template_vars: { new_date: "2026-07-02" },
    });
    assertEquals(retry.sent, true);
    const dup = await sendClientUpdate(client, {
      job_id: "job-1",
      comms_trigger: "install_rescheduled",
      template_vars: { new_date: "2026-07-02" },
    });
    assertEquals(dup.sent, false);
  } finally {
    stub.restore();
  }
});

Deno.test("install_rescheduled: a non-fencing job names its own service — never 'fence'", async () => {
  const { calls, restore } = stubFetch();
  try {
    const store = baseStore();
    store.jobs!["job-1"].type = "patio";
    const res = await sendClientUpdate(makeClient(store), {
      job_id: "job-1",
      comms_trigger: "install_rescheduled",
      template_vars: { new_date: "2026-07-02" },
    });
    assertEquals(res.sent, true);
    const body = JSON.parse(smsCalls(calls)[0].init.body);
    assertStringIncludes(body.message, "your patio install rescheduled");
    assert(!body.message.includes("fence"), "patio SMS must not say fence");
  } finally {
    restore();
  }
});

Deno.test("install_rescheduled: caller-supplied template_vars.service cannot override the job's own service", async () => {
  const { calls, restore } = stubFetch();
  try {
    const store = baseStore();
    const res = await sendClientUpdate(makeClient(store), {
      job_id: "job-1",
      comms_trigger: "install_rescheduled",
      template_vars: { new_date: "2026-07-02", service: "SPOOFED" },
    });
    assertEquals(res.sent, true);
    const body = JSON.parse(smsCalls(calls)[0].init.body);
    assertEquals(body.message, EXPECTED_SMS);
  } finally {
    restore();
  }
});

Deno.test("install_rescheduled: calendar-invalid new_date rejected with 400 — no garbage SMS", async () => {
  const { calls, restore } = stubFetch();
  try {
    for (const bad of ["2026-02-30", "2026-13-01", "2026-02-29"]) {
      await assertRejects(
        () =>
          sendClientUpdate(makeClient(baseStore()), {
            job_id: "job-1",
            comms_trigger: "install_rescheduled",
            template_vars: { new_date: bad },
          }),
        Error,
        "new_date",
      );
    }
    assertEquals(smsCalls(calls).length, 0);
  } finally {
    restore();
  }
});

Deno.test("install_rescheduled: requires template_vars.new_date (YYYY-MM-DD)", async () => {
  const { restore } = stubFetch();
  try {
    await assertRejects(
      () =>
        sendClientUpdate(makeClient(baseStore()), {
          job_id: "job-1",
          comms_trigger: "install_rescheduled",
        }),
      Error,
      "new_date",
    );
  } finally {
    restore();
  }
});

Deno.test("other SMS triggers keep the cross-sell footer and once-per-job dedup (no regression)", async () => {
  const { calls, restore } = stubFetch();
  try {
    const store = baseStore();
    const client = makeClient(store);
    const res = await sendClientUpdate(client, {
      job_id: "job-1",
      comms_trigger: "quote_accepted",
    });
    assertEquals(res.sent, true);
    const body = JSON.parse(smsCalls(calls)[0].init.body);
    assertStringIncludes(body.message, "SecureWorks Group — Patios | Fencing");
    const dup = await sendClientUpdate(client, {
      job_id: "job-1",
      comms_trigger: "quote_accepted",
    });
    assertEquals(dup.sent, false);
  } finally {
    restore();
  }
});

// ── Pure formatting helpers ────────────────────────────────────────────────
Deno.test("formatDayDateMonth: '[day] the [date] of [month]' with correct ordinals", () => {
  assertEquals(formatDayDateMonth("2026-07-02"), "Thursday the 2nd of July");
  assertEquals(formatDayDateMonth("2026-07-01"), "Wednesday the 1st of July");
  assertEquals(formatDayDateMonth("2026-07-13"), "Monday the 13th of July"); // 11-13 are 'th'
  assertEquals(formatDayDateMonth("2026-07-21"), "Tuesday the 21st of July");
  assertEquals(formatDayDateMonth("2026-07-22"), "Wednesday the 22nd of July");
  assertEquals(formatDayDateMonth("2026-07-31"), "Friday the 31st of July");
  assertEquals(formatDayDateMonth("2026-08-03"), "Monday the 3rd of August");
});

Deno.test("streetFromAddress: street name only — numbers, units and suburb tail stripped", () => {
  assertEquals(
    streetFromAddress("12 Example St, Padbury WA 6025"),
    "Example St",
  );
  assertEquals(streetFromAddress("12A Ocean Drive"), "Ocean Drive");
  assertEquals(streetFromAddress("U2/34 Foo Street, Padbury"), "Foo Street");
  assertEquals(streetFromAddress("3/45 Bar Rd, Suburb"), "Bar Rd");
  assertEquals(streetFromAddress("Lot 5 Acacia Way"), "Acacia Way");
  assertEquals(streetFromAddress(null), "your property");
  assertEquals(streetFromAddress(""), "your property");
});
