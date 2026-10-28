// deno-lint-ignore-file no-import-prefix no-explicit-any
// Job bookings (Ops Dash calendar, owner's go 28 Oct 2026): the light read of
// a job's bookings and the all-or-nothing move / stretch of them.
// ---------------------------------------------------------------------------
//   Planner   the port of the calendar's planJobMove / planJobStretch keeps
//             the weekend rule and every gap (Fri, Mon, Tue, Thu one working
//             day later is Mon, Tue, Wed, Fri).
//   Order     no write lands on a key another pending write still holds, and
//             a row the plan does not move refuses the plan before any write.
//   Write     ONE rpc carries the whole plan. The fake rpc here applies it the
//             way reschedule_job_assignments_v1 does (all rows or none); the
//             real function's all-or-nothing is proved in Postgres by the
//             migration contract 20261028150000_reschedule_job_assignments.
//   After     GHL push once per job, ghost sync once per date, events per
//             created/deleted row, and nothing at all after a refusal.
// Nothing here touches a live service: every follow-up is an injected stub.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type JobBookingRow,
  type JobBookingsDeps,
  JobBookingsError,
  layWorkingDays,
  orderPlanForWrite,
  paintedSpanDates,
  parseRescheduleBody,
  planJobBookingMove,
  planJobBookingStretch,
  readJobBookings,
  rescheduleJobBookings,
  shiftWorkingDays,
} from "./job_bookings.ts";
import { _opsApiActionNeedsStaffRole } from "./index.ts";

const JOB = "11111111-1111-4111-8111-111111111111";
const ARI = "a0000000-0000-4000-8000-00000000000a";
const BO = "a0000000-0000-4000-8000-00000000000b";
const WREN = "a0000000-0000-4000-8000-00000000000c";

// Fri 30 Oct 2026, then Mon 2 Nov to Fri 6 Nov.
function row(
  id: string,
  userId: string | null,
  date: string,
  end: string | null = date,
  extra: Partial<JobBookingRow> = {},
): JobBookingRow {
  return {
    id,
    job_id: JOB,
    user_id: userId,
    crew_name: userId === ARI
      ? "Ari"
      : userId === BO
      ? "Bo"
      : userId === WREN
      ? "Wren"
      : "Name only",
    role: "lead_installer",
    status: "scheduled",
    assignment_type: "install",
    is_ghost: false,
    scheduled_date: date,
    scheduled_end: end,
    duration_days: 1,
    start_time: null,
    end_time: null,
    confirmation_status: "tentative",
    attendance_cycle_id: null,
    cycle_attribution: null,
    ...extra,
  };
}

// ── Pure planner ─────────────────────────────────────────────────────────────

Deno.test("working-day math matches the calendar: weekends are breaks unless chosen as an end", () => {
  assertEquals(layWorkingDays("2026-11-02", 5), "2026-11-06"); // Mon,5 -> Fri
  assertEquals(layWorkingDays("2026-11-02", 6), "2026-11-09"); // Mon,6 -> next Mon
  assertEquals(layWorkingDays("2026-10-30", 2), "2026-11-02"); // Fri,2 -> Mon
  assertEquals(layWorkingDays("2026-10-31", 2), "2026-11-02"); // Sat,2 -> Mon
  assertEquals(paintedSpanDates("2026-10-30", "2026-11-02"), [
    "2026-10-30",
    "2026-11-02",
  ]);
  assertEquals(paintedSpanDates("2026-10-30", "2026-10-31"), [
    "2026-10-30",
    "2026-10-31",
  ]);
  assertEquals(shiftWorkingDays("2026-10-30", 1), "2026-11-02");
  assertEquals(shiftWorkingDays("2026-11-02", -1), "2026-10-30");
  assertEquals(shiftWorkingDays("2026-11-02", 5), "2026-11-09");
});

Deno.test("move keeps every gap and the weekend rule: Fri, Mon, Tue, Thu one working day later is Mon, Tue, Wed, Fri", () => {
  const rows = [
    row("r1", ARI, "2026-10-30"),
    row("r2", ARI, "2026-11-02"),
    row("r3", ARI, "2026-11-03"),
    row("r4", ARI, "2026-11-05"),
  ];
  const plan = planJobBookingMove(rows, "2026-11-02");
  const landed = Object.fromEntries(
    plan.updates.map((u) => [u.id, u.scheduled_date]),
  );
  assertEquals(landed, {
    r1: "2026-11-02",
    r2: "2026-11-03",
    r3: "2026-11-04",
    r4: "2026-11-06",
  });
  assertEquals(plan.from, { start: "2026-10-30", end: "2026-11-05" });
  assertEquals(plan.to, { start: "2026-11-02", end: "2026-11-06" });
});

Deno.test("move keeps a multi-day row's working-day length across a weekend", () => {
  // Thu-Mon is three worked days (Thu, Fri, Mon); moved to Mon it is Mon-Wed.
  const plan = planJobBookingMove([
    row("m1", BO, "2026-10-29", "2026-11-02", { duration_days: 3 }),
  ], "2026-11-02");
  assertEquals(plan.updates[0].scheduled_date, "2026-11-02");
  assertEquals(plan.updates[0].scheduled_end, "2026-11-04");
  assertEquals(plan.updates[0].duration_days, 3);
});

Deno.test("move never touches a ghost, a cancelled or completed row, or a meeting", () => {
  const rows = [
    row("live", ARI, "2026-11-02"),
    row("ghost", WREN, "2026-11-02", "2026-11-02", {
      is_ghost: true,
      role: "observer",
      assignment_type: "observer",
    }),
    row("cancelled", BO, "2026-11-03", "2026-11-03", { status: "cancelled" }),
    row("done", BO, "2026-11-02", "2026-11-02", { status: "complete" }),
    row("meeting", BO, "2026-11-04", "2026-11-04", {
      assignment_type: "meeting",
    }),
  ];
  const plan = planJobBookingMove(rows, "2026-11-03");
  assertEquals(plan.updates.map((u) => u.id), ["live"]);
});

Deno.test("stretch end adds the same working days for every crew member, extending a multi-day row", () => {
  const rows = [
    row("a1", ARI, "2026-11-02"),
    row("a2", ARI, "2026-11-03"),
    row("a3", ARI, "2026-11-04"),
    row("b1", BO, "2026-11-02", "2026-11-04", { duration_days: 3 }),
  ];
  const plan = planJobBookingStretch(rows, "end", "2026-11-09"); // Wed -> next Mon, over the weekend
  assertEquals(plan.creates.map((c) => `${c.user_id}@${c.scheduled_date}`), [
    `${ARI}@2026-11-05`,
    `${ARI}@2026-11-06`,
    `${ARI}@2026-11-09`,
  ]);
  assert(
    plan.creates.every((c) =>
      c.confirmation_status === "tentative" && c.duration_days === 1
    ),
  );
  assertEquals(
    plan.updates.map((
      u,
    ) => [u.id, u.scheduled_date, u.scheduled_end, u.duration_days]),
    [
      ["b1", "2026-11-02", "2026-11-09", 6],
    ],
  );
  assertEquals(plan.to, { start: "2026-11-02", end: "2026-11-09" });
});

Deno.test("stretch start inward takes the days off every crew member and keeps their gaps", () => {
  const rows = [
    row("a1", ARI, "2026-11-02"),
    row("a3", ARI, "2026-11-04"),
    row("b1", BO, "2026-11-02", "2026-11-04", { duration_days: 3 }),
  ];
  const plan = planJobBookingStretch(rows, "start", "2026-11-04");
  assertEquals(plan.deletes.map((d) => d.id), ["a1"]);
  assertEquals(
    plan.updates.map((u) => [u.id, u.scheduled_date, u.scheduled_end]),
    [["b1", "2026-11-04", "2026-11-04"]],
  );
  assertEquals(plan.creates, []);
});

Deno.test("stretch lists a name-only crew member it would have to add days to, and still resizes one it need not", () => {
  // Adding Wed gives every crew member Wed, and a crew member with no user
  // cannot be booked: the action refuses the whole stretch (crew_without_user).
  const grow = planJobBookingStretch(
    [
      row("a1", ARI, "2026-11-02", "2026-11-03", { duration_days: 2 }),
      row("n1", null, "2026-11-02"),
    ],
    "end",
    "2026-11-04",
  );
  assertEquals(grow.unbookable.map((r) => r.id), ["n1"]);
  // Taking Mon off resizes the name-only row in place; nothing is added.
  const shrink = planJobBookingStretch(
    [
      row("a1", ARI, "2026-11-02", "2026-11-03", { duration_days: 2 }),
      row("n1", null, "2026-11-02", "2026-11-03", { duration_days: 2 }),
    ],
    "start",
    "2026-11-03",
  );
  assertEquals(shrink.unbookable, []);
  assertEquals(
    shrink.updates.map((u) => [u.id, u.scheduled_date, u.scheduled_end]).sort(),
    [["a1", "2026-11-03", "2026-11-03"], ["n1", "2026-11-03", "2026-11-03"]],
  );
});

// ── Write order and the date clash check ─────────────────────────────────────

Deno.test("write order frees each key before a booking lands on it", () => {
  const rows = [
    row("r1", ARI, "2026-11-02"),
    row("r2", ARI, "2026-11-03"),
    row("r3", ARI, "2026-11-04"),
  ];
  const plan = planJobBookingMove(rows, "2026-11-03");
  const ordered = orderPlanForWrite(rows, plan, new Set());
  assertEquals(ordered.map((u) => u.id), ["r3", "r2", "r1"]);
  const back = planJobBookingMove(rows, "2026-10-30");
  assertEquals(orderPlanForWrite(rows, back, new Set()).map((u) => u.id), [
    "r1",
    "r2",
    "r3",
  ]);
});

Deno.test("a row the plan does not move refuses it before any write, a watcher's own ghost does not", () => {
  const rows = [
    row("r1", ARI, "2026-11-02"),
    row("held", ARI, "2026-11-03", "2026-11-03", { status: "cancelled" }),
    row("w1", WREN, "2026-11-02"),
    row("wghost", WREN, "2026-11-03", "2026-11-03", {
      is_ghost: true,
      role: "observer",
      assignment_type: "observer",
    }),
  ];
  const ariPlan = planJobBookingMove([rows[0]], "2026-11-03");
  const err = (() => {
    try {
      orderPlanForWrite(rows, ariPlan, new Set([WREN]));
    } catch (e) {
      return e;
    }
  })() as JobBookingsError;
  assert(err instanceof JobBookingsError);
  assertEquals([err.code, err.status, err.details.held_by], [
    "booking_date_taken",
    409,
    "held",
  ]);

  const wrenPlan = planJobBookingMove([rows[2]], "2026-11-03");
  assertEquals(
    orderPlanForWrite(rows, wrenPlan, new Set([WREN])).map((u) => u.id),
    ["w1"],
  );
  // Not a watcher: the ghost row on the key is a holder like any other.
  let refused = false;
  try {
    orderPlanForWrite(rows, wrenPlan, new Set());
  } catch (e) {
    refused = (e as JobBookingsError).code === "booking_date_taken";
  }
  assert(refused);
});

// ── The action, against an in-memory store ──────────────────────────────────

type Store = {
  job: Record<string, any> | null;
  rows: JobBookingRow[];
  detail: Record<string, any> | null;
  /** Rows another writer adds between the action's read and its write. */
  concurrent?: JobBookingRow[];
  rpcCalls: any[];
  directWrites: Array<{ table: string; op: string; payload?: any }>;
  orFilters: string[];
};

function sameKey(
  a: JobBookingRow,
  b: { user_id: any; scheduled_date: string },
) {
  return a.user_id && b.user_id && String(a.user_id) === String(b.user_id) &&
    a.scheduled_date === b.scheduled_date;
}

// Applies a plan the way reschedule_job_assignments_v1 does: on a copy of the
// rows, committed only when every write succeeds.
function fakeReschedule(store: Store, args: any) {
  if (store.concurrent) {
    store.rows.push(...store.concurrent);
    store.concurrent = undefined;
  }
  const work = store.rows.map((r) => ({ ...r }));
  const refuse = (reason: string, hint: Record<string, unknown>) => ({
    data: null,
    error: {
      code: "JB409",
      message: "Not changed",
      details: reason,
      hint: JSON.stringify(hint),
    },
  });
  const deleted: any[] = [];
  for (const d of args.p_deletes) {
    const i = work.findIndex((r) => r.id === d.id);
    if (i < 0 || work[i].scheduled_date !== d.expected_scheduled_date) {
      return refuse("booking_changed", { assignment_id: d.id });
    }
    deleted.push(work.splice(i, 1)[0]);
  }
  const updated: any[] = [];
  for (const u of args.p_updates) {
    const r = work.find((x) => x.id === u.id);
    if (!r || r.scheduled_date !== u.expected_scheduled_date) {
      return refuse("booking_changed", { assignment_id: u.id });
    }
    for (let i = work.length - 1; i >= 0; i--) {
      const g = work[i];
      if (
        g.id !== r.id && g.is_ghost &&
        args.p_release_ghost_user_ids.includes(String(g.user_id)) &&
        sameKey(g, { user_id: r.user_id, scheduled_date: u.scheduled_date })
      ) work.splice(i, 1);
    }
    if (
      work.some((x) =>
        x.id !== r.id &&
        sameKey(x, { user_id: r.user_id, scheduled_date: u.scheduled_date })
      )
    ) {
      return refuse("booking_date_taken", {
        assignment_id: r.id,
        scheduled_date: u.scheduled_date,
      });
    }
    Object.assign(r, {
      scheduled_date: u.scheduled_date,
      scheduled_end: u.scheduled_end,
      duration_days: u.duration_days,
      ...(u.attendance_cycle_id
        ? {
          attendance_cycle_id: u.attendance_cycle_id,
          cycle_attribution: u.cycle_attribution,
        }
        : {}),
    });
    updated.push({ ...r });
  }
  const created: any[] = [];
  args.p_creates.forEach((c: any, i: number) => {
    const r = {
      ...c,
      id: `new-${i}`,
      job_id: JOB,
      status: "scheduled",
      is_ghost: false,
    } as JobBookingRow;
    work.push(r);
    created.push({ ...r });
  });
  store.rows = work;
  return {
    data: {
      updated,
      created,
      deleted,
      bookings: work.filter((r) => r.status !== "cancelled"),
    },
    error: null,
  };
}

function makeClient(store: Store) {
  function builder(table: string) {
    let op = "select";
    let payload: any = null;
    const b: any = {
      select: () => b,
      insert: (p: any) => {
        op = "insert";
        payload = p;
        store.directWrites.push({ table, op, payload: p });
        return b;
      },
      update: (p: any) => {
        op = "update";
        payload = p;
        store.directWrites.push({ table, op, payload: p });
        return b;
      },
      delete: () => {
        op = "delete";
        store.directWrites.push({ table, op });
        return b;
      },
      eq: () => b,
      or: (f: string) => {
        store.orFilters.push(f);
        return b;
      },
      order: () => b,
      in: () => b,
      limit: () => b,
      maybeSingle: () => {
        if (table === "jobs") {
          return Promise.resolve({ data: store.job, error: null });
        }
        if (table === "makesafe_job_details") {
          return Promise.resolve({ data: store.detail, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then: (res: any, rej: any) => {
        const data = op === "select" && table === "job_assignments"
          ? store.rows.map((r) => ({ ...r }))
          : op === "select"
          ? []
          : null;
        void payload;
        return Promise.resolve({ data, error: null }).then(res, rej);
      },
    };
    return b;
  }
  return {
    from: (t: string) => builder(t),
    rpc: (name: string, args: any) => {
      store.rpcCalls.push({ name, args });
      return Promise.resolve(fakeReschedule(store, args));
    },
  };
}

function makeDeps(overrides: Partial<JobBookingsDeps> = {}) {
  const calls = {
    ghl: [] as string[],
    ghostSync: [] as string[],
    events: [] as any[],
    cycles: [] as string[],
    reconciled: [] as string[],
    intelligence: 0,
  };
  const deps: JobBookingsDeps = {
    isMakesafeJobType: (job) => String(job?.type) === "makesafe",
    ensureAttendanceCycle: (_jobId, n, reason) => {
      calls.cycles.push(`${n}:${reason}`);
      return Promise.resolve({ id: "cycle-1" });
    },
    reconcileReportBinding: (p) => {
      calls.reconciled.push(p.userId);
      return Promise.resolve();
    },
    isGenuineTradeAssignment: () => true,
    logBusinessEvent: (e) => {
      calls.events.push(e);
    },
    pushGhlScheduledDate: (_opp, date) => {
      calls.ghl.push(date);
    },
    recomputeJobIntelligence: () => {
      calls.intelligence++;
    },
    ghostWatcherUserIds: () => Promise.resolve([WREN]),
    syncGhostWatchers: (_jobId, date) => {
      calls.ghostSync.push(date);
      return Promise.resolve();
    },
    releasedInvoiceStatuses: ["draft", "failed", "ops-reject"],
    ...overrides,
  };
  return { deps, calls };
}

function makeStore(rows: JobBookingRow[], extra: Partial<Store> = {}): Store {
  return {
    job: {
      id: JOB,
      type: "fencing",
      job_number: "SWF-1",
      status: "scheduled",
      ghl_opportunity_id: "opp-1",
    },
    rows,
    detail: null,
    rpcCalls: [],
    directWrites: [],
    orFilters: [],
    ...extra,
  };
}

const MILAN_ROWS = () => [
  row("a1", ARI, "2026-11-02"),
  row("a2", ARI, "2026-11-03"),
  row("b1", BO, "2026-11-02"),
  row("b2", BO, "2026-11-03"),
];

Deno.test("a whole-job move is one write, then one GHL push and one ghost sync per date", async () => {
  const store = makeStore(MILAN_ROWS());
  const { deps, calls } = makeDeps();
  const out = await rescheduleJobBookings(makeClient(store), {
    job_id: JOB,
    mode: "move",
    shift_working_days: 1,
  }, deps);

  assertEquals(store.rpcCalls.length, 1);
  assertEquals(store.rpcCalls[0].name, "reschedule_job_assignments_v1");
  // Each crew member's Tue row is written before their Mon row moves onto Tue.
  const order = store.rpcCalls[0].args.p_updates.map((u: any) => u.id);
  assert(order.indexOf("a2") < order.indexOf("a1"));
  assert(order.indexOf("b2") < order.indexOf("b1"));
  assertEquals(
    store.directWrites.filter((w) => w.table === "job_assignments"),
    [],
  );

  assertEquals(out.changed, true);
  assertEquals(out.to, { start: "2026-11-03", end: "2026-11-04" });
  assertEquals(calls.ghl, ["2026-11-03"]);
  assertEquals(calls.ghostSync, ["2026-11-02", "2026-11-03", "2026-11-04"]);
  assertEquals(calls.events, []);
  assertEquals(out.follow_up_failures, []);
  assertEquals(Object.keys(out.bookings[0]).sort(), [
    "id",
    "is_ghost",
    "role",
    "scheduled_date",
    "scheduled_end",
    "status",
    "user_id",
  ]);
  assertEquals(
    store.rows.find((r) => r.id === "a1")!.scheduled_date,
    "2026-11-03",
  );
});

Deno.test("a clash midway through the write applies nothing and runs no follow-up", async () => {
  // Read: Ari Mon/Tue, Bo Mon/Tue. Between the read and the write another
  // writer books Bo on Wed, so Bo's Tue row (written after Ari's two moves
  // have landed on the copy) cannot move there.
  const store = makeStore(MILAN_ROWS(), {
    concurrent: [row("late", BO, "2026-11-04")],
  });
  const { deps, calls } = makeDeps();
  const before = JSON.stringify([
    ...MILAN_ROWS(),
    row("late", BO, "2026-11-04"),
  ]);

  const err = await assertRejects(
    () =>
      rescheduleJobBookings(makeClient(store), {
        job_id: JOB,
        mode: "move",
        new_start: "2026-11-03",
      }, deps),
    JobBookingsError,
  );
  assertEquals([err.code, err.status], ["booking_date_taken", 409]);
  // The plan's first writes were Ari's, so a per-row writer would have left
  // Ari on the new dates and Bo on the old. Nothing moved.
  assertEquals(store.rpcCalls.length, 1);
  assertEquals(JSON.stringify(store.rows), before);
  assertEquals(store.directWrites, []);
  assertEquals([calls.ghl, calls.ghostSync, calls.events, calls.reconciled], [
    [],
    [],
    [],
    [],
  ]);
});

Deno.test("a clash with a row the plan cannot move is refused before the write", async () => {
  const store = makeStore([
    ...MILAN_ROWS(),
    row("x", ARI, "2026-11-04", "2026-11-04", { status: "cancelled" }),
  ]);
  const { deps, calls } = makeDeps();
  const err = await assertRejects(
    () =>
      rescheduleJobBookings(makeClient(store), {
        job_id: JOB,
        mode: "move",
        shift_working_days: 1,
      }, deps),
    JobBookingsError,
  );
  assertEquals(err.code, "booking_date_taken");
  assertEquals(store.rpcCalls.length, 0);
  assertEquals(calls.ghl, []);
});

Deno.test("a stretch that adds days creates silent tentative rows, logs each, and advances an accepted job once", async () => {
  const store = makeStore([
    row("a1", ARI, "2026-11-02"),
    row("a2", ARI, "2026-11-03"),
    row("b1", BO, "2026-11-02", "2026-11-03"),
  ]);
  store.job!.status = "accepted";
  const { deps, calls } = makeDeps();
  const out = await rescheduleJobBookings(makeClient(store), {
    job_id: JOB,
    mode: "stretch",
    edge: "end",
    target: "2026-11-05",
    operator_email: "ops@example.test",
  }, deps);

  const creates = store.rpcCalls[0].args.p_creates;
  assertEquals(creates.map((c: any) => c.scheduled_date), [
    "2026-11-04",
    "2026-11-05",
  ]);
  assert(
    creates.every((c: any) =>
      c.user_id === ARI && c.confirmation_status === "tentative" &&
      c.visible_to_trades === null
    ),
  );
  assertEquals(
    store.rpcCalls[0].args.p_updates.map((u: any) => [u.id, u.scheduled_end]),
    [["b1", "2026-11-05"]],
  );
  assertEquals(calls.events.map((e) => e.event_type), [
    "schedule.assignment_created",
    "schedule.assignment_created",
  ]);
  assertEquals(
    store.directWrites.filter((w) => w.table === "jobs").map((w) =>
      w.payload.status
    ),
    ["processing"],
  );
  const jarvis = store.directWrites.filter((w) =>
    w.table === "jarvis_event_log"
  );
  assertEquals(jarvis.length, 1);
  assertEquals(jarvis[0].payload.length, 2);
  assertEquals(calls.intelligence, 1);
  assertEquals(calls.ghl, ["2026-11-02"]);
  assertEquals(out.created.length, 2);
});

Deno.test("a stretch that takes days off logs each deleted row and refuses a crew member with no user", async () => {
  const store = makeStore([
    row("a1", ARI, "2026-11-02"),
    row("a2", ARI, "2026-11-03"),
    row("a3", ARI, "2026-11-04"),
  ]);
  const { deps, calls } = makeDeps();
  const out = await rescheduleJobBookings(makeClient(store), {
    job_id: JOB,
    mode: "stretch",
    edge: "end",
    target: "2026-11-03",
  }, deps);
  assertEquals(out.deleted, ["a3"]);
  assertEquals(calls.events.map((e) => e.event_type), [
    "schedule.assignment_deleted",
  ]);
  assertEquals(calls.ghostSync, ["2026-11-04"]);

  const store2 = makeStore([
    row("a1", ARI, "2026-11-02", "2026-11-03"),
    row("n1", null, "2026-11-02"),
    row("n2", null, "2026-11-02"),
  ]);
  const err = await assertRejects(
    () =>
      rescheduleJobBookings(makeClient(store2), {
        job_id: JOB,
        mode: "stretch",
        edge: "end",
        target: "2026-11-04",
      }, makeDeps().deps),
    JobBookingsError,
  );
  assertEquals(err.code, "crew_without_user");
  assertEquals(store2.rpcCalls.length, 0);
});

Deno.test("make-safe: unbound rows are bound to the current cycle once, bound rows keep theirs, new rows are visible to trades", async () => {
  const store = makeStore([
    row("u1", ARI, "2026-11-02", "2026-11-03"),
    row("k1", BO, "2026-11-02", "2026-11-02", {
      attendance_cycle_id: "cycle-0",
      cycle_attribution: "bound",
    }),
    row("k2", BO, "2026-11-03", "2026-11-03", {
      attendance_cycle_id: "cycle-0",
      cycle_attribution: "bound",
    }),
  ], { detail: { cycle_number: 2 } });
  store.job!.type = "makesafe";
  const { deps, calls } = makeDeps();
  await rescheduleJobBookings(makeClient(store), {
    job_id: JOB,
    mode: "stretch",
    edge: "end",
    target: "2026-11-04",
  }, deps);
  assertEquals(calls.cycles, ["2:assignment_reassign", "2:allocate_job"]);
  const args = store.rpcCalls[0].args;
  assertEquals(
    args.p_updates.map((u: any) => [u.id, u.attendance_cycle_id ?? null]),
    [["u1", "cycle-1"]],
  );
  assertEquals(
    args.p_creates.map((
      c: any,
    ) => [c.user_id, c.visible_to_trades, c.attendance_cycle_id]),
    [[BO, true, "cycle-1"]],
  );
  // Report binding: once per crew member written onto a bound cycle.
  assertEquals(calls.reconciled.sort(), [ARI, BO].sort());
});

Deno.test("only the named bookings move, and a named booking that is no longer live refuses", async () => {
  const store = makeStore(MILAN_ROWS());
  const { deps } = makeDeps();
  await rescheduleJobBookings(makeClient(store), {
    job_id: JOB,
    mode: "move",
    new_start: "2026-11-04",
    assignment_ids: ["a2", "b2"],
  }, deps);
  assertEquals(store.rpcCalls[0].args.p_updates.map((u: any) => u.id).sort(), [
    "a2",
    "b2",
  ]);

  const err = await assertRejects(
    () =>
      rescheduleJobBookings(makeClient(makeStore(MILAN_ROWS())), {
        job_id: JOB,
        mode: "move",
        new_start: "2026-11-04",
        assignment_ids: ["a2", "gone"],
      }, deps),
    JobBookingsError,
  );
  assertEquals([err.code, err.details.assignment_ids], ["booking_not_live", [
    "gone",
  ]]);
});

Deno.test("a follow-up failure is reported and never undoes the committed move", async () => {
  const store = makeStore(MILAN_ROWS());
  const { deps } = makeDeps({
    syncGhostWatchers: () => Promise.reject(new Error("ghost read failed")),
  });
  const out = await rescheduleJobBookings(makeClient(store), {
    job_id: JOB,
    mode: "move",
    shift_working_days: 1,
  }, deps);
  assertEquals(out.ok, true);
  assert(out.follow_up_failures.length > 0);
  assertEquals(out.follow_up_failures[0].step, "ghost_watchers");
  assertEquals(
    store.rows.find((r) => r.id === "b1")!.scheduled_date,
    "2026-11-03",
  );
});

Deno.test("a move onto the day it already starts changes nothing and writes nothing", async () => {
  const store = makeStore(MILAN_ROWS());
  const out = await rescheduleJobBookings(makeClient(store), {
    job_id: JOB,
    mode: "move",
    new_start: "2026-11-02",
  }, makeDeps().deps);
  assertEquals(out.changed, false);
  assertEquals(store.rpcCalls.length, 0);
});

Deno.test("the request body is checked before anything is read", () => {
  const code = (body: any) => {
    try {
      parseRescheduleBody(body);
      return "ok";
    } catch (e) {
      return (e as JobBookingsError).code;
    }
  };
  assertEquals(
    code({ mode: "move", new_start: "2026-11-02" }),
    "job_id_required",
  );
  assertEquals(code({ job_id: JOB, mode: "swap" }), "mode_invalid");
  assertEquals(code({ job_id: JOB, mode: "move" }), "move_target_required");
  assertEquals(
    code({ job_id: JOB, mode: "move", new_start: "2026-02-30" }),
    "new_start_invalid",
  );
  assertEquals(
    code({ job_id: JOB, mode: "move", shift_working_days: 0 }),
    "move_target_required",
  );
  assertEquals(
    code({
      job_id: JOB,
      mode: "stretch",
      edge: "middle",
      target: "2026-11-02",
    }),
    "edge_invalid",
  );
  assertEquals(
    code({ job_id: JOB, mode: "stretch", edge: "end" }),
    "target_invalid",
  );
  assertEquals(
    code({
      job_id: JOB,
      mode: "move",
      new_start: "2026-11-02",
      assignment_ids: [],
    }),
    "assignment_ids_invalid",
  );
  assertEquals(
    code({ job_id: JOB, mode: "move", shift_working_days: -2 }),
    "ok",
  );
});

// ── The light read ───────────────────────────────────────────────────────────

Deno.test("job_bookings returns exactly the seven booking fields, keeping NULL-status rows", async () => {
  const store = makeStore([
    row("a1", ARI, "2026-11-02", "2026-11-03", { status: null }),
  ]);
  const out = await readJobBookings(makeClient(store), JOB);
  assertEquals(out.job_id, JOB);
  assertEquals(out.bookings, [{
    id: "a1",
    user_id: ARI,
    role: "lead_installer",
    status: null,
    is_ghost: false,
    scheduled_date: "2026-11-02",
    scheduled_end: "2026-11-03",
  }]);
  assertEquals(store.orFilters, ["status.is.null,status.neq.cancelled"]);

  const err = await assertRejects(
    () => readJobBookings(makeClient(makeStore([], { job: null })), JOB),
    JobBookingsError,
  );
  assertEquals([err.code, err.status], ["job_not_found", 404]);
});

Deno.test("both actions take the assignment gate in the route, as update_assignment does", () => {
  for (
    const action of [
      "job_bookings",
      "reschedule_job_bookings",
      "update_assignment",
    ]
  ) {
    assertEquals(
      _opsApiActionNeedsStaffRole(
        new URL(`https://x.test/ops-api?action=${action}`),
      ),
      false,
      action,
    );
  }
});
