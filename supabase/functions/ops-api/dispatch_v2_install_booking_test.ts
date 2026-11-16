// deno-lint-ignore-file no-explicit-any
// Dispatch v2 Book install (dispatch_v2_install_booking.ts). The presses run
// against fake deps that record every call, so each test can say exactly
// which of the Calendar's own booking functions ran, with what, and that
// nobody was texted unless Confirm was pressed.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import {
  DISPATCH_INSTALL_SMS_FROM,
  dispatchInstallCrewText,
  dispatchInstallView,
  dispatchInstallWorkingDays,
  DispatchInstallError,
  type DispatchInstallRow,
  parseDispatchInstallBook,
  runDispatchV2InstallAction,
} from "./dispatch_v2_install_booking.ts";

const JOB = "11111111-1111-4111-8111-111111111111";
const HENRY = "22222222-2222-4222-8222-222222222222";
const JAN = "33333333-3333-4333-8333-333333333333";
const NOPHONE = "44444444-4444-4444-8444-444444444444";

type Calls = Record<string, any[]>;

function fakeDeps(opts: {
  rows?: DispatchInstallRow[];
  job?: any;
  failCreateAt?: number;
  textOk?: boolean;
  rescheduleChanged?: boolean;
} = {}) {
  const calls: Calls = {
    create: [],
    confirm: [],
    update: [],
    delete: [],
    reschedule: [],
    text: [],
    stamp: [],
  };
  let rows: DispatchInstallRow[] = [...(opts.rows || [])];
  let n = 0;
  const job = opts.job === undefined
    ? {
      id: JOB,
      type: "fencing",
      status: "order_confirmed",
      job_number: "SWF-261999",
      client_name: "Example Client",
      site_address: "1 Test St",
      site_suburb: "Perthville",
    }
    : opts.job;
  const users = [
    { id: HENRY, name: "Henry Builder", phone: "+61400000001" },
    { id: JAN, name: "Jan Helper", phone: "+61400000002" },
    { id: NOPHONE, name: "No Phone", phone: "" },
  ];
  const deps = {
    readJob: async () => job,
    readBookings: async () => rows.map((r) => ({ ...r })),
    readUsers: async (ids: string[]) => users.filter((u) => ids.includes(u.id)),
    createAssignment: async (b: any) => {
      calls.create.push(b);
      if (opts.failCreateAt && calls.create.length === opts.failCreateAt) {
        throw new Error("insert failed");
      }
      const id = `row-${++n}`;
      rows.push({
        id,
        job_id: JOB,
        user_id: b.userId,
        crew_name: b.crewName,
        role: b.role,
        status: "scheduled",
        assignment_type: b.assignmentType,
        is_ghost: false,
        scheduled_date: b.scheduledDate,
        scheduled_end: b.scheduledEnd,
        confirmation_status: b.confirmationStatus,
        created_at: "2026-11-16T06:10:00Z",
      });
      return { assignment: { id } };
    },
    confirmAssignment: async (b: any) => {
      calls.confirm.push(b);
      rows = rows.map((r) =>
        r.id === b.assignmentId ? { ...r, confirmation_status: "confirmed" } : r
      );
      return { success: true };
    },
    updateAssignment: async (b: any) => {
      calls.update.push(b);
      rows = rows.map((r) =>
        r.id === b.assignmentId
          ? { ...r, confirmation_status: b.confirmation_status }
          : r
      );
      return { success: true };
    },
    deleteAssignment: async (b: any) => {
      calls.delete.push(b);
      rows = rows.filter((r) => r.id !== b.assignmentId);
      return { success: true };
    },
    rescheduleJobBookings: async (b: any) => {
      calls.reschedule.push(b);
      return {
        changed: opts.rescheduleChanged !== false,
        from: { start: "2026-11-20", end: "2026-11-20" },
        to: { start: b.new_start, end: b.new_start },
      };
    },
    sendCrewText: async (phone: string, message: string, jobId: string) => {
      calls.text.push({ phone, message, jobId });
      return opts.textOk !== false;
    },
    markCrewNotified: async (ids: string[], at: string) => {
      calls.stamp.push({ ids, at });
    },
    now: () => "2026-11-16T06:20:00Z",
  };
  return { deps, calls, rows: () => rows };
}

const CTX = { operatorEmail: "admin@example.test", operatorUserId: null };
const P = new URLSearchParams();

function row(
  id: string,
  user: string,
  day: string,
  extra: Partial<DispatchInstallRow> = {},
): DispatchInstallRow {
  return {
    id,
    job_id: JOB,
    user_id: user,
    crew_name: user === HENRY ? "Henry" : user === JAN ? "Jan" : "No Phone",
    role: user === HENRY ? "lead_installer" : "helper",
    status: "scheduled",
    assignment_type: "install",
    is_ghost: false,
    scheduled_date: day,
    scheduled_end: day,
    confirmation_status: "tentative",
    created_at: "2026-11-16T06:10:00Z",
    ...extra,
  };
}

// ── Working days ────────────────────────────────────────────────────────────

Deno.test("working days skip the weekend", () => {
  // Thu 19 Nov 2026, 3 days: Thu, Fri, Mon.
  assertEquals(dispatchInstallWorkingDays("2026-11-19", 3), [
    "2026-11-19",
    "2026-11-20",
    "2026-11-23",
  ]);
});

Deno.test("a weekend first day starts on the Monday", () => {
  assertEquals(dispatchInstallWorkingDays("2026-11-21", 1), ["2026-11-23"]);
});

// ── Parsing ─────────────────────────────────────────────────────────────────

Deno.test("book request: days default to 1, helpers deduped, lead kept first", () => {
  const req = parseDispatchInstallBook({
    job_id: JOB,
    first_day: "2026-11-20",
    lead: { user_id: HENRY, name: "Henry" },
    helpers: [{ user_id: JAN, name: "Jan" }, { user_id: HENRY }, {
      user_id: JAN,
    }],
  });
  assertEquals(req.days, 1);
  assertEquals(req.crew.map((c) => [c.user_id, c.role]), [
    [HENRY, "lead_installer"],
    [JAN, "helper"],
  ]);
});

Deno.test("book request: refused without a lead, a date or with too many days", () => {
  const bad = [
    { job_id: JOB, first_day: "2026-11-20" },
    { job_id: JOB, lead: { user_id: HENRY } },
    { job_id: JOB, first_day: "2026-11-20", days: 0, lead: { user_id: HENRY } },
    { job_id: JOB, first_day: "2026-11-20", days: 21, lead: { user_id: HENRY } },
    { job_id: JOB, first_day: "2026-02-30", lead: { user_id: HENRY } },
    { job_id: "nope", first_day: "2026-11-20", lead: { user_id: HENRY } },
    { job_id: JOB, first_day: "2026-11-20", lead: { user_id: "free text" } },
  ];
  for (const body of bad) {
    let threw = false;
    try {
      parseDispatchInstallBook(body);
    } catch (e) {
      threw = e instanceof DispatchInstallError && e.status === 400;
    }
    assert(threw, JSON.stringify(body));
  }
});

// ── Book ────────────────────────────────────────────────────────────────────

Deno.test("Book makes one tentative silent row per person per working day", async () => {
  const { deps, calls } = fakeDeps();
  const res: any = await runDispatchV2InstallAction(
    "dispatch_v2_install_book",
    P,
    {
      job_id: JOB,
      first_day: "2026-11-20",
      days: 2,
      lead: { user_id: HENRY, name: "Henry" },
      helpers: [{ user_id: JAN, name: "Jan" }],
      note: "Colorbond 1.8m, side gate",
    },
    CTX,
    deps,
  );
  assertEquals(res.booked_days, ["2026-11-20", "2026-11-23"]);
  assertEquals(calls.create.length, 4);
  for (const b of calls.create) {
    assertEquals(b.confirmationStatus, "tentative");
    assertEquals(b.suppress_notifications, true);
    assertEquals(b.keep_job_status, true);
    assertEquals(b.assignmentType, "install");
    assertEquals(b.scheduledEnd, b.scheduledDate);
    assertEquals(b.durationDays, 1);
    assertEquals(b.notes, "Colorbond 1.8m, side gate");
    assert(b.crewName, "crew_name is always written");
    assert(b.userId, "a real user is always written");
  }
  assertEquals(calls.create.filter((b) => b.role === "lead_installer").length, 2);
  assertEquals(calls.create.filter((b) => b.role === "helper").length, 2);
  assertEquals(calls.text.length, 0);
  assertEquals(calls.confirm.length, 0);
  assertEquals(res.job_status_changed, false);
  assertEquals(res.install.state, "tentative");
  assertEquals(res.install.people.map((p: any) => p.name), ["Henry", "Jan"]);
});

Deno.test("Book uses the user record name when the screen sent none", async () => {
  const { deps, calls } = fakeDeps();
  await runDispatchV2InstallAction("dispatch_v2_install_book", P, {
    job_id: JOB,
    first_day: "2026-11-20",
    lead: { user_id: HENRY },
  }, CTX, deps);
  assertEquals(calls.create[0].crewName, "Henry Builder");
});

Deno.test("Book is refused when an install is already booked", async () => {
  const { deps, calls } = fakeDeps({ rows: [row("a", HENRY, "2026-11-20")] });
  const e = await assertRejects(() =>
    runDispatchV2InstallAction("dispatch_v2_install_book", P, {
      job_id: JOB,
      first_day: "2026-11-24",
      lead: { user_id: HENRY },
    }, CTX, deps), DispatchInstallError) as DispatchInstallError;
  assertEquals(e.status, 409);
  assertEquals(e.body.code, "already_booked");
  assertEquals(calls.create.length, 0);
});

Deno.test("a ghost or cancelled row does not count as booked", async () => {
  const { deps, calls } = fakeDeps({
    rows: [
      row("g", HENRY, "2026-11-20", { is_ghost: true, role: "observer" }),
      row("c", JAN, "2026-11-20", { status: "cancelled" }),
    ],
  });
  await runDispatchV2InstallAction("dispatch_v2_install_book", P, {
    job_id: JOB,
    first_day: "2026-11-24",
    lead: { user_id: HENRY },
  }, CTX, deps);
  assertEquals(calls.create.length, 1);
});

Deno.test("Book with a crew id not on record is refused before any write", async () => {
  const { deps, calls } = fakeDeps();
  const e = await assertRejects(() =>
    runDispatchV2InstallAction("dispatch_v2_install_book", P, {
      job_id: JOB,
      first_day: "2026-11-20",
      lead: { user_id: "55555555-5555-4555-8555-555555555555" },
    }, CTX, deps), DispatchInstallError) as DispatchInstallError;
  assertEquals(e.body.code, "crew_unknown");
  assertEquals(calls.create.length, 0);
});

Deno.test("a failed row takes back every row the press made", async () => {
  const { deps, calls, rows } = fakeDeps({ failCreateAt: 3 });
  const e = await assertRejects(() =>
    runDispatchV2InstallAction("dispatch_v2_install_book", P, {
      job_id: JOB,
      first_day: "2026-11-20",
      days: 2,
      lead: { user_id: HENRY },
      helpers: [{ user_id: JAN }],
    }, CTX, deps), DispatchInstallError) as DispatchInstallError;
  assertEquals(e.status, 500);
  assertEquals(e.body.code, "book_failed");
  assertEquals(e.body.left_on_calendar, 0);
  assertEquals(calls.delete.length, 2);
  assertEquals(rows().length, 0);
});

Deno.test("Book refuses a job that is not Dispatch work", async () => {
  const { deps } = fakeDeps({
    job: { id: JOB, type: "makesafe", status: "processing" },
  });
  const e = await assertRejects(() =>
    runDispatchV2InstallAction("dispatch_v2_install_book", P, {
      job_id: JOB,
      first_day: "2026-11-20",
      lead: { user_id: HENRY },
    }, CTX, deps), DispatchInstallError) as DispatchInstallError;
  assertEquals(e.body.code, "not_dispatch_work");
});

Deno.test("an unknown job is a 404", async () => {
  const { deps } = fakeDeps({ job: null });
  const e = await assertRejects(() =>
    runDispatchV2InstallAction("dispatch_v2_install", P, { job_id: JOB }, CTX, deps),
    DispatchInstallError,
  ) as DispatchInstallError;
  assertEquals(e.status, 404);
});

// ── Confirm ─────────────────────────────────────────────────────────────────

Deno.test("Confirm locks every tentative row and texts each person once", async () => {
  const { deps, calls } = fakeDeps({
    rows: [
      row("a", HENRY, "2026-11-20"),
      row("b", HENRY, "2026-11-23"),
      row("c", JAN, "2026-11-20"),
      row("g", HENRY, "2026-11-20", { is_ghost: true, role: "observer" }),
    ],
  });
  const res: any = await runDispatchV2InstallAction(
    "dispatch_v2_install_confirm",
    P,
    { job_id: JOB },
    CTX,
    deps,
  );
  assertEquals(calls.confirm.map((b) => b.assignmentId).sort(), ["a", "b", "c"]);
  for (const b of calls.confirm) assertEquals(b.notifyClient, false);
  assertEquals(calls.text.length, 2);
  const henry = calls.text.find((t) => t.phone === "+61400000001");
  assertStringIncludes(henry.message, "New job assigned: SWF-261999 - Example Client");
  assertStringIncludes(henry.message, "Dates: 2026-11-20, 2026-11-23");
  const jan = calls.text.find((t) => t.phone === "+61400000002");
  assertStringIncludes(jan.message, "Date: 2026-11-20");
  assertEquals(res.texted.sort(), ["Henry", "Jan"]);
  assertEquals(res.client_texted, false);
  assertEquals(res.install.state, "confirmed");
  assertEquals(calls.stamp.length, 2);
});

Deno.test("Confirm names who has no phone and whose text failed", async () => {
  const one = fakeDeps({ rows: [row("a", NOPHONE, "2026-11-20")] });
  const r1: any = await runDispatchV2InstallAction(
    "dispatch_v2_install_confirm",
    P,
    { job_id: JOB },
    CTX,
    one.deps,
  );
  assertEquals(r1.no_phone, ["No Phone"]);
  assertEquals(one.calls.text.length, 0);

  const two = fakeDeps({ rows: [row("a", HENRY, "2026-11-20")], textOk: false });
  const r2: any = await runDispatchV2InstallAction(
    "dispatch_v2_install_confirm",
    P,
    { job_id: JOB },
    CTX,
    two.deps,
  );
  assertEquals(r2.text_failed, ["Henry"]);
  assertEquals(two.calls.stamp.length, 0);
});

Deno.test("Confirm on a confirmed install is refused and texts nobody", async () => {
  const { deps, calls } = fakeDeps({
    rows: [row("a", HENRY, "2026-11-20", { confirmation_status: "confirmed" })],
  });
  const e = await assertRejects(() =>
    runDispatchV2InstallAction("dispatch_v2_install_confirm", P, {
      job_id: JOB,
    }, CTX, deps), DispatchInstallError) as DispatchInstallError;
  assertEquals(e.body.code, "already_confirmed");
  assertEquals(calls.text.length, 0);
});

// ── Move ────────────────────────────────────────────────────────────────────

Deno.test("Move is one whole-job reschedule and texts nobody", async () => {
  const { deps, calls } = fakeDeps({
    rows: [row("a", HENRY, "2026-11-20"), row("b", JAN, "2026-11-20")],
  });
  const res: any = await runDispatchV2InstallAction(
    "dispatch_v2_install_move",
    P,
    { job_id: JOB, new_start: "2026-11-25" },
    CTX,
    deps,
  );
  assertEquals(calls.reschedule.length, 1);
  assertEquals(calls.reschedule[0].mode, "move");
  assertEquals(calls.reschedule[0].new_start, "2026-11-25");
  assertEquals(calls.update.length, 0);
  assertEquals(calls.text.length, 0);
  assertEquals(res.changed, true);
});

Deno.test("Move puts a confirmed booking back to tentative", async () => {
  const { deps, calls } = fakeDeps({
    rows: [
      row("a", HENRY, "2026-11-20", { confirmation_status: "confirmed" }),
      row("b", JAN, "2026-11-20"),
    ],
  });
  const res: any = await runDispatchV2InstallAction(
    "dispatch_v2_install_move",
    P,
    { job_id: JOB, new_start: "2026-11-25" },
    CTX,
    deps,
  );
  assertEquals(calls.update.map((b) => [b.assignmentId, b.confirmation_status]), [[
    "a",
    "tentative",
  ]]);
  assertEquals(res.back_to_tentative, 1);
  assertEquals(calls.text.length, 0);
});

Deno.test("a move the server did not make leaves the locks alone", async () => {
  const { deps, calls } = fakeDeps({
    rows: [row("a", HENRY, "2026-11-20", { confirmation_status: "confirmed" })],
    rescheduleChanged: false,
  });
  await runDispatchV2InstallAction("dispatch_v2_install_move", P, {
    job_id: JOB,
    new_start: "2026-11-20",
  }, CTX, deps);
  assertEquals(calls.update.length, 0);
});

Deno.test("Move needs a date and a booking", async () => {
  const { deps } = fakeDeps({ rows: [row("a", HENRY, "2026-11-20")] });
  await assertRejects(() =>
    runDispatchV2InstallAction("dispatch_v2_install_move", P, {
      job_id: JOB,
      new_start: "soon",
    }, CTX, deps), DispatchInstallError);
  const empty = fakeDeps();
  const e = await assertRejects(() =>
    runDispatchV2InstallAction("dispatch_v2_install_move", P, {
      job_id: JOB,
      new_start: "2026-11-25",
    }, CTX, empty.deps), DispatchInstallError) as DispatchInstallError;
  assertEquals(e.body.code, "not_booked");
});

// ── Remove ──────────────────────────────────────────────────────────────────

Deno.test("Remove deletes every install row and never a ghost", async () => {
  const { deps, calls } = fakeDeps({
    rows: [
      row("a", HENRY, "2026-11-20"),
      row("b", JAN, "2026-11-20"),
      row("g", HENRY, "2026-11-20", { is_ghost: true, role: "observer" }),
      row("m", HENRY, "2026-11-20", { assignment_type: "meeting" }),
    ],
  });
  const res: any = await runDispatchV2InstallAction(
    "dispatch_v2_install_remove",
    P,
    { job_id: JOB },
    CTX,
    deps,
  );
  assertEquals(calls.delete.map((b) => b.assignmentId).sort(), ["a", "b"]);
  assertEquals(res.removed, 2);
  assertEquals(res.install.booked, false);
  assertEquals(calls.text.length, 0);
});

Deno.test("Remove reports a row it could not take off", async () => {
  const { deps } = fakeDeps({ rows: [row("a", HENRY, "2026-11-20")] });
  deps.deleteAssignment = async () => {
    throw new Error("This crew member has already invoiced this job");
  };
  const res: any = await runDispatchV2InstallAction(
    "dispatch_v2_install_remove",
    P,
    { job_id: JOB },
    CTX,
    deps,
  );
  assertEquals(res.success, false);
  assertEquals(res.removed, 0);
  assertStringIncludes(res.failed[0], "already invoiced");
});

// ── The read ────────────────────────────────────────────────────────────────

Deno.test("the view: days, people lead first, state and a multi-day Calendar row", () => {
  const v = dispatchInstallView(JOB, [
    row("b", JAN, "2026-11-20", { confirmation_status: "confirmed" }),
    // A Calendar row over a weekend: Fri 20 to Mon 23 counts Fri and Mon.
    row("a", HENRY, "2026-11-20", { scheduled_end: "2026-11-23" }),
  ]);
  assertEquals(v.days, ["2026-11-20", "2026-11-23"]);
  assertEquals(v.people.map((p) => p.name), ["Henry", "Jan"]);
  assertEquals(v.state, "mixed");
  assertEquals(v.first_day, "2026-11-20");
  assertEquals(v.last_day, "2026-11-23");
});

Deno.test("the read takes job_id from the query string", async () => {
  const { deps } = fakeDeps({ rows: [row("a", HENRY, "2026-11-20")] });
  const res: any = await runDispatchV2InstallAction(
    "dispatch_v2_install",
    new URLSearchParams({ job_id: JOB }),
    {},
    CTX,
    deps,
  );
  assertEquals(res.install.booked, true);
  assertEquals(res.install.booking_ids, ["a"]);
});

Deno.test("the crew text is create_assignment's wording", () => {
  const msg = dispatchInstallCrewText({
    id: JOB,
    job_number: "SWF-1",
    client_name: "A Client",
    site_address: "1 St",
    site_suburb: "Town",
  }, ["2026-11-20"]);
  assertEquals(
    msg,
    `New job assigned: SWF-1 - A Client\nSite: 1 St, Town\nDate: 2026-11-20\nOpen in Trade: https://secureworks-group.github.io/secureworks-ux/trade.html#job/${JOB}`,
  );
  assertEquals(DISPATCH_INSTALL_SMS_FROM, "+61489267771");
});
