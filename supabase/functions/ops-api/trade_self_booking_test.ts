// deno-lint-ignore-file no-explicit-any no-import-prefix
// A trade books themselves ahead on a job, and takes their own booking off
// again (Marnin, 13 Nov 2026; flag trade_self_booking_v1, seeded off).
// Contract: docs/trade-open-access-v1.md.
//
//   1. the rules (trade_self_allocation.ts) against stand-in deps,
//   2. the same rules through the REAL createAssignment / deleteAssignment on
//      an in-memory store that enforces the one-row-per-job-user-day key,
//   3. the front door: a plain trade reaches both actions, and with the switch
//      off both answer 409 self_booking_disabled and write nothing.
import "./trade_app_visibility_rules_test_env.ts";
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _MAKESAFE_POOL_EXCLUDED_STATUSES,
  _opsApiRequestHandlerForTest,
  createAssignment,
  deleteAssignment,
} from "./index.ts";
import {
  SELF_BOOK_MAX_DATES,
  SELF_BOOK_NOTE,
  selfAllocateForInvoice,
  selfBookingDates,
  selfBookingDayPlan,
  selfBookingJobRefusal,
  SelfBookingRefusal,
  selfBookJob,
  selfUnbookJob,
} from "./trade_self_allocation.ts";
import { GHOST_WATCHERS } from "./ghost_observer_mirror.ts";

const TODAY = "2026-11-13";
const TRADE = { id: "trade-1", orgId: "org-1", name: "Sam Trade" };
const LIVE_JOB = {
  id: "job-1",
  org_id: "org-1",
  job_number: "SWF-1001",
  status: "scheduled",
  type: "fencing",
  metadata: {},
};

// ── Stand-ins ───────────────────────────────────────────────────────────────

type World = {
  job?: any;
  assignment?: any;
  events?: any[];
};

function fakeClient(world: World) {
  const calls: any[] = [];
  const client = {
    calls,
    from(table: string) {
      const q: any = { table, filters: [] as any[], op: "select", payload: null };
      const rows = () => {
        if (table === "job_events") {
          return (world.events || []).filter((ev: any) =>
            q.filters.every(([c, v]: any) => String(ev[c]) === String(v))
          );
        }
        return [];
      };
      const chain: any = {
        select() {
          return chain;
        },
        eq(col: string, val: unknown) {
          q.filters.push([col, val]);
          return chain;
        },
        update(payload: any) {
          q.op = "update";
          q.payload = payload;
          return chain;
        },
        insert(payload: any) {
          calls.push({ table, op: "insert", payload });
          return Promise.resolve({ error: null });
        },
        maybeSingle() {
          calls.push({ ...q });
          if (table === "jobs") {
            const orgOk = q.filters.some(([c, v]: any) => c === "org_id" && v === world.job?.org_id);
            return Promise.resolve({ data: world.job && orgOk ? world.job : null, error: null });
          }
          if (table === "job_assignments" && q.op === "update") {
            return Promise.resolve({
              data: { id: q.filters.find(([c]: any) => c === "id")?.[1], status: q.payload.status, user_id: TRADE.id },
              error: null,
            });
          }
          if (table === "job_assignments") {
            const id = q.filters.find(([c]: any) => c === "id")?.[1];
            return Promise.resolve({
              data: world.assignment && world.assignment.id === id ? world.assignment : null,
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve: any, reject: any) {
          calls.push({ ...q });
          return Promise.resolve({ data: rows(), error: null }).then(resolve, reject);
        },
      };
      return chain;
    },
  };
  return client;
}

function bookDeps(over: Partial<any> = {}) {
  const created: any[] = [];
  let n = 0;
  return {
    created,
    value: {
      today: TODAY,
      bookingEnabled: () => Promise.resolve(true),
      findOwnRows: () => Promise.resolve([] as any[]),
      createAssignment: (body: any) => {
        created.push(body);
        return Promise.resolve({
          assignment: {
            id: body.revive_cancelled_assignment_id || `asn-${++n}`,
            status: "scheduled",
            user_id: body.userId,
            scheduled_date: body.scheduledDate,
          },
        });
      },
      isUserDateConflict: (e: any) => e?.code === "23505",
      notSchedulableStatuses: _MAKESAFE_POOL_EXCLUDED_STATUSES,
      ...over,
    },
  };
}

const book = (client: any, body: any, deps: any) =>
  selfBookJob(client, { body, trade: TRADE }, deps);

async function refusal(fn: () => Promise<unknown>): Promise<SelfBookingRefusal> {
  return await assertRejects(fn, SelfBookingRefusal) as SelfBookingRefusal;
}

// ── 1. Rules ────────────────────────────────────────────────────────────────

Deno.test("self_book_job: with the switch off it refuses 409 self_booking_disabled and reads and writes nothing", async () => {
  const client = fakeClient({ job: LIVE_JOB });
  const d = bookDeps({ bookingEnabled: () => Promise.resolve(false) });
  const err = await refusal(() => book(client, { job_id: "job-1", dates: [TODAY] }, d.value));
  assertEquals([err.code, err.status], ["self_booking_disabled", 409]);
  assertEquals(d.created.length, 0);
  assertEquals(client.calls.length, 0, "not even the job is read");
});

Deno.test("self_book_job dates: today to sixty days ahead, one to fourteen different days, a single work_date accepted", () => {
  assertEquals(selfBookingDates({ dates: [TODAY] }, TODAY), [TODAY]);
  assertEquals(selfBookingDates({ work_date: "2026-11-20" }, TODAY), ["2026-11-20"]);
  // sixty days ahead is the last day; sixty-one is refused
  assertEquals(selfBookingDates({ dates: ["2027-01-12"] }, TODAY), ["2027-01-12"]);
  const code = (body: any) => {
    try {
      selfBookingDates(body, TODAY);
      return null;
    } catch (e) {
      return (e as SelfBookingRefusal).code;
    }
  };
  assertEquals(code({ dates: ["2027-01-13"] }), "self_book_date_too_far");
  // yesterday belongs to the invoice door, not this one
  assertEquals(code({ dates: ["2026-11-12"] }), "self_book_past_date");
  assertEquals(code({ dates: ["2026-02-30"] }), "self_book_date_invalid");
  assertEquals(code({ dates: ["soon"] }), "self_book_date_invalid");
  assertEquals(code({ dates: [] }), "self_book_dates_required");
  assertEquals(code({}), "self_book_dates_required");
  // the same day twice is one day, and the answer is in date order
  assertEquals(
    selfBookingDates({ dates: ["2026-11-16", "2026-11-14", "2026-11-16"] }, TODAY),
    ["2026-11-14", "2026-11-16"],
  );
  const many = Array.from({ length: SELF_BOOK_MAX_DATES + 1 }, (_, i) => `2026-11-${String(13 + i).padStart(2, "0")}`);
  assertEquals(code({ dates: many }), "self_book_too_many_dates");
  assertEquals(selfBookingDates({ dates: many.slice(0, SELF_BOOK_MAX_DATES) }, TODAY).length, SELF_BOOK_MAX_DATES);
});

Deno.test("self_book_job job rule: everything the invoice door refuses, and also a finished or closed job", () => {
  const refused = (status: string, metadata: any = {}) =>
    selfBookingJobRefusal({ status, metadata, job_number: "SWF-1" }, _MAKESAFE_POOL_EXCLUDED_STATUSES)?.code ?? null;
  for (const status of ["lead", "new", "draft", "quoted", "lost", "cancelled", "deleted", "duplicate", "void"]) {
    assertEquals(refused(status), "self_book_job_not_open", status);
  }
  // Finished and closed: allowed for an invoice, never for a booking ahead.
  for (const status of ["complete", "completed", "invoiced", "paid", "closed", "archived", "final_payment", "get_review"]) {
    assertEquals(refused(status), "self_book_job_not_open", status);
  }
  // Every status allocate_job refuses is refused here too.
  for (const status of _MAKESAFE_POOL_EXCLUDED_STATUSES) {
    assertEquals(refused(status), "self_book_job_not_open", status);
  }
  for (const status of ["accepted", "processing", "order_confirmed", "schedule_install", "scheduled", "in_progress", "rectification"]) {
    assertEquals(refused(status), null, status);
  }
  assertEquals(refused("scheduled", { do_not_schedule: "true" }), "self_book_job_not_open");
});

Deno.test("self_book_job: books only the caller, each day asked, no text, accepted, with the note and a planned job event", async () => {
  const client = fakeClient({ job: LIVE_JOB });
  const d = bookDeps();
  const res = await book(client, {
    job_id: "job-1",
    dates: ["2026-11-17", "2026-11-14"],
    userId: "someone-else",
    user_id: "someone-else",
  }, d.value);
  assertEquals(res.ok, true);
  assertEquals(res.bookings.map((b) => [b.work_date, b.mode]), [["2026-11-14", "created"], ["2026-11-17", "created"]]);
  assertEquals(res.bookings.every((b) => b.assignment.status === "confirmed"), true);
  assertEquals(d.created.length, 2);
  for (const body of d.created) {
    assertEquals(body.userId, TRADE.id, "a body user id is never used");
    assertEquals(body.jobId, "job-1");
    assertEquals(body.suppress_notifications, true, "nobody is texted");
    assertEquals(body.allocated_by_user_id, TRADE.id);
    assertEquals(body.confirmation_status, "confirmed");
    assertEquals(body.notes, SELF_BOOK_NOTE);
    assertEquals(body.notes, "Added themselves in the app");
    assertEquals("revive_cancelled_assignment_id" in body, false);
    // an ordinary install booking: no type or role override
    assertEquals("assignmentType" in body || "assignment_type" in body || "role" in body, false);
  }
  const events = client.calls.filter((c: any) => c.op === "insert" && c.table === "job_events");
  assertEquals(events.length, 2);
  assertEquals(events[0].payload.event_type, "trade_self_allocated");
  assertEquals(events[0].payload.user_id, TRADE.id);
  assertEquals(events[0].payload.detail_json.reason, "planned");
  assertEquals(events[0].payload.detail_json.work_date, "2026-11-14");
  assertEquals(events[0].payload.detail_json.assignment_id, res.bookings[0].assignment.id);
});

Deno.test("self_book_job: a day the trade already holds is returned as existing and nothing is written for it", async () => {
  const client = fakeClient({ job: LIVE_JOB });
  const d = bookDeps({
    findOwnRows: () => Promise.resolve([{ id: "asn-old", scheduled_date: "2026-11-14", status: "confirmed", is_ghost: false }]),
  });
  const res = await book(client, { job_id: "job-1", dates: ["2026-11-14", "2026-11-15"] }, d.value);
  assertEquals(res.bookings.map((b) => [b.work_date, b.mode, b.assignment.id]), [
    ["2026-11-14", "existing", "asn-old"],
    ["2026-11-15", "created", "asn-1"],
  ]);
  assertEquals(d.created.length, 1);
  assertEquals(d.created[0].scheduledDate, "2026-11-15");
});

Deno.test("self_book_job: a cancelled, unused row of the trade's on that day is brought back, not inserted over", async () => {
  const client = fakeClient({ job: LIVE_JOB });
  const d = bookDeps({
    findOwnRows: () => Promise.resolve([{ id: "asn-cancelled", scheduled_date: "2026-11-14", status: "cancelled", is_ghost: false }]),
  });
  const res = await book(client, { job_id: "job-1", dates: ["2026-11-14"] }, d.value);
  assertEquals(res.bookings.map((b) => [b.mode, b.assignment.id]), [["revived", "asn-cancelled"]]);
  assertEquals(d.created[0].revive_cancelled_assignment_id, "asn-cancelled");
  const event = client.calls.find((c: any) => c.op === "insert" && c.table === "job_events");
  assertEquals(event.payload.detail_json.mode, "revived");
});

Deno.test("self_book_job day plan: a watcher's ghost is not a booking; a cancelled row that was worked or invoiced is never reused", () => {
  assertEquals(selfBookingDayPlan("2026-11-14", null), { day: "2026-11-14", action: "create" });
  assertEquals(
    selfBookingDayPlan("2026-11-14", { id: "g", status: "scheduled", is_ghost: true }),
    { day: "2026-11-14", action: "create" },
  );
  assertEquals(
    selfBookingDayPlan("2026-11-14", { id: "g", status: "cancelled", is_ghost: true }),
    { day: "2026-11-14", action: "create" },
  );
  for (
    const used of [
      { invoiced_in: "inv-1" },
      { started_at: "2026-11-01T00:00:00Z" },
      { clocked_on_at: "2026-11-01T00:00:00Z" },
      { completed_at: "2026-11-01T00:00:00Z" },
      { hours_worked: 2 },
    ]
  ) {
    assertEquals(selfBookingDayPlan("2026-11-14", { id: "c", status: "cancelled", ...used }), "conflict", JSON.stringify(used));
  }
});

Deno.test("self_book_job: every day is checked before the first write (a bad day, a used cancelled row, a closed job)", async () => {
  // one clean day and one day holding a used cancelled row: nothing is booked
  const dirty = bookDeps({
    findOwnRows: () =>
      Promise.resolve([{ id: "asn-used", scheduled_date: "2026-11-15", status: "cancelled", invoiced_in: "inv-1" }]),
  });
  const conflict = await refusal(() =>
    book(fakeClient({ job: LIVE_JOB }), { job_id: "job-1", dates: ["2026-11-14", "2026-11-15"] }, dirty.value)
  );
  assertEquals([conflict.code, conflict.status, conflict.bookings], ["self_book_conflict", 409, []]);
  assertEquals(dirty.created.length, 0);

  // one good day and one past day
  const past = bookDeps();
  const pastErr = await refusal(() =>
    book(fakeClient({ job: LIVE_JOB }), { job_id: "job-1", dates: ["2026-11-14", "2026-11-12"] }, past.value)
  );
  assertEquals(pastErr.code, "self_book_past_date");
  assertEquals(past.created.length, 0);

  // a finished job, a job in another company, no job
  const closed = bookDeps();
  const closedErr = await refusal(() =>
    book(fakeClient({ job: { ...LIVE_JOB, status: "complete" } }), { job_id: "job-1", dates: [TODAY] }, closed.value)
  );
  assertEquals([closedErr.code, closedErr.status], ["self_book_job_not_open", 409]);
  const foreign = await refusal(() =>
    book(fakeClient({ job: { ...LIVE_JOB, org_id: "org-2" } }), { job_id: "job-1", dates: [TODAY] }, closed.value)
  );
  assertEquals([foreign.code, foreign.status], ["self_book_job_not_found", 404]);
  const none = await refusal(() => book(fakeClient({ job: LIVE_JOB }), { dates: [TODAY] }, closed.value));
  assertEquals([none.code, none.status], ["self_book_job_required", 400]);
  assertEquals(closed.created.length, 0);
});

Deno.test("self_book_job: a unique-key race returns the row that won; with no live row it refuses and says what was booked", async () => {
  let reads = 0;
  const won = bookDeps({
    findOwnRows: () =>
      Promise.resolve(reads++ === 0 ? [] : [{ id: "asn-raced", scheduled_date: "2026-11-14", status: "scheduled" }]),
    createAssignment: () => Promise.reject(Object.assign(new Error("dup"), { code: "23505" })),
  });
  const res = await book(fakeClient({ job: LIVE_JOB }), { job_id: "job-1", dates: ["2026-11-14"] }, won.value);
  assertEquals(res.bookings.map((b) => [b.mode, b.assignment.id]), [["existing", "asn-raced"]]);

  let n = 0;
  const lost = bookDeps({
    createAssignment: (body: any) =>
      n++ === 0
        ? Promise.resolve({ assignment: { id: "asn-first", status: "scheduled", user_id: body.userId } })
        : Promise.reject(Object.assign(new Error("dup"), { code: "23505" })),
  });
  const err = await refusal(() =>
    book(fakeClient({ job: LIVE_JOB }), { job_id: "job-1", dates: ["2026-11-14", "2026-11-15"] }, lost.value)
  );
  assertEquals(err.code, "self_book_conflict");
  assertEquals(err.bookings.map((b) => [b.work_date, b.mode]), [["2026-11-14", "created"]]);
});

Deno.test("self_allocate_for_invoice is unchanged: a future day is still refused there, and its note and event say invoice", async () => {
  const d = bookDeps();
  await assertRejects(() =>
    selfAllocateForInvoice(fakeClient({ job: LIVE_JOB }), { body: { job_id: "job-1", work_date: "2026-11-14" }, trade: TRADE }, {
      today: TODAY,
      findExisting: () => Promise.resolve(null),
      createAssignment: d.value.createAssignment,
      isUserDateConflict: d.value.isUserDateConflict,
    })
  );
  assertEquals(d.created.length, 0);
  const client = fakeClient({ job: { ...LIVE_JOB, status: "complete" } });
  const res = await selfAllocateForInvoice(client, { body: { job_id: "job-1", work_date: "2026-11-12" }, trade: TRADE }, {
    today: TODAY,
    findExisting: () => Promise.resolve(null),
    createAssignment: d.value.createAssignment,
    isUserDateConflict: d.value.isUserDateConflict,
  });
  assertEquals(res.mode, "created", "a finished job is still allowed for an invoice");
  assertEquals(d.created[0].notes, "Added themselves from their invoice");
  const event = client.calls.find((c: any) => c.op === "insert" && c.table === "job_events");
  assertEquals(event.payload.detail_json, {
    assignment_id: "asn-1",
    work_date: "2026-11-12",
    reason: "invoice",
    trade_name: "Sam Trade",
  });
});

// ── self_unbook_job ─────────────────────────────────────────────────────────

const OWN_ROW = {
  id: "asn-1",
  job_id: "job-1",
  user_id: TRADE.id,
  scheduled_date: "2026-11-14",
  status: "confirmed",
  is_ghost: false,
  invoiced_in: null,
  started_at: null,
  clocked_on_at: null,
};
const SELF_EVENT = {
  id: "ev-1",
  job_id: "job-1",
  user_id: TRADE.id,
  event_type: "trade_self_allocated",
  detail_json: { assignment_id: "asn-1", reason: "planned" },
};

function unbookDeps(over: Partial<any> = {}) {
  const deleted: any[] = [];
  return {
    deleted,
    value: {
      today: TODAY,
      bookingEnabled: () => Promise.resolve(true),
      deleteAssignment: (body: any) => {
        deleted.push(body);
        return Promise.resolve({ success: true });
      },
      ...over,
    },
  };
}

const unbook = (world: World, deps: any, body: any = { assignment_id: "asn-1" }) =>
  selfUnbookJob(fakeClient(world), { body, trade: TRADE }, deps);

Deno.test("self_unbook_job: with the switch off it refuses 409 self_booking_disabled and removes nothing", async () => {
  const d = unbookDeps({ bookingEnabled: () => Promise.resolve(false) });
  const err = await refusal(() => unbook({ assignment: OWN_ROW, events: [SELF_EVENT] }, d.value));
  assertEquals([err.code, err.status], ["self_booking_disabled", 409]);
  assertEquals(d.deleted.length, 0);
});

Deno.test("self_unbook_job: the trade's own self-made, unstarted, uninvoiced booking for today or later is removed through the office's removal", async () => {
  for (const row of [OWN_ROW, { ...OWN_ROW, status: "scheduled", scheduled_date: TODAY }]) {
    const d = unbookDeps();
    const client = fakeClient({ assignment: row, events: [SELF_EVENT] });
    const res = await selfUnbookJob(client, { body: { assignment_id: "asn-1" }, trade: TRADE }, d.value);
    assertEquals(res, { ok: true, assignment_id: "asn-1", job_id: "job-1", work_date: row.scheduled_date });
    assertEquals(d.deleted, [{ assignmentId: "asn-1" }]);
    const event = client.calls.find((c: any) => c.op === "insert" && c.table === "job_events");
    assertEquals(event.payload.event_type, "trade_self_unbooked");
    assertEquals(event.payload.user_id, TRADE.id);
    assertEquals(event.payload.detail_json.assignment_id, "asn-1");
    assertEquals(event.payload.detail_json.work_date, row.scheduled_date);
  }
});

Deno.test("self_unbook_job: each refusal, and nothing is removed", async () => {
  const cases: Array<[string, World, string, number, any?]> = [
    ["no such booking", { events: [SELF_EVENT] }, "self_unbook_not_found", 404],
    ["another trade's booking", { assignment: { ...OWN_ROW, user_id: "trade-2" }, events: [SELF_EVENT] }, "self_unbook_not_found", 404],
    ["a watcher row", { assignment: { ...OWN_ROW, is_ghost: true }, events: [SELF_EVENT] }, "self_unbook_not_found", 404],
    ["the office booked it", { assignment: OWN_ROW, events: [] }, "self_unbook_not_self_made", 403],
    [
      "self-made, but a different booking",
      { assignment: OWN_ROW, events: [{ ...SELF_EVENT, detail_json: { assignment_id: "asn-9" } }] },
      "self_unbook_not_self_made",
      403,
    ],
    [
      "someone else's self-booking event",
      { assignment: OWN_ROW, events: [{ ...SELF_EVENT, user_id: "trade-2" }] },
      "self_unbook_not_self_made",
      403,
    ],
    ["clocked on", { assignment: { ...OWN_ROW, clocked_on_at: "2026-11-14T00:00:00Z" }, events: [SELF_EVENT] }, "self_unbook_started", 409],
    ["started", { assignment: { ...OWN_ROW, started_at: "2026-11-14T00:00:00Z" }, events: [SELF_EVENT] }, "self_unbook_started", 409],
    ["in progress", { assignment: { ...OWN_ROW, status: "in_progress" }, events: [SELF_EVENT] }, "self_unbook_started", 409],
    ["complete", { assignment: { ...OWN_ROW, status: "complete" }, events: [SELF_EVENT] }, "self_unbook_started", 409],
    ["on an invoice", { assignment: { ...OWN_ROW, invoiced_in: "inv-1" }, events: [SELF_EVENT] }, "self_unbook_invoiced", 409],
    ["yesterday", { assignment: { ...OWN_ROW, scheduled_date: "2026-11-12" }, events: [SELF_EVENT] }, "self_unbook_past", 409],
    ["no booking named", { assignment: OWN_ROW, events: [SELF_EVENT] }, "self_unbook_assignment_required", 400, {}],
  ];
  for (const [label, world, code, status, body] of cases) {
    const d = unbookDeps();
    const err = await refusal(() => unbook(world, d.value, body ?? { assignment_id: "asn-1" }));
    assertEquals([err.code, err.status], [code, status], label);
    assert(err.message.length > 10 && !/_/.test(err.message), `${label}: a plain sentence`);
    assertEquals(d.deleted.length, 0, label);
  }
});

// ── 2. Through the real createAssignment / deleteAssignment ─────────────────

type Row = Record<string, any>;
type Store = Record<string, Row[]>;

const UNIQUE_KEY_ERROR = {
  code: "23505",
  message: 'duplicate key value violates unique constraint "job_assignments_job_user_date_key"',
  details: "Key (job_id, user_id, scheduled_date) already exists.",
};

function violatesKey(rows: Row[], candidate: Row, selfId?: string): boolean {
  if (candidate.user_id == null || candidate.job_id == null || candidate.scheduled_date == null) return false;
  return rows.some((r) =>
    r.id !== selfId && r.job_id === candidate.job_id && r.user_id === candidate.user_id &&
    r.scheduled_date === candidate.scheduled_date
  );
}

// In-memory, PostgREST-shaped. job_assignments rows default is_ghost to false
// as the live column does, and the one-row-per-job-user-day key is enforced on
// insert and update, cancelled rows included.
function memoryClient(store: Store) {
  function from(table: string) {
    store[table] = store[table] || [];
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let payload: any = null;
    const preds: Array<(r: Row) => boolean> = [];
    const exec = (): { data: any; error: any } => {
      if (mode === "insert") {
        const created = (Array.isArray(payload) ? payload : [payload]).map((r: Row) => ({
          id: r.id ?? crypto.randomUUID(),
          ...(table === "job_assignments" ? { is_ghost: false } : {}),
          ...r,
        }));
        if (table === "job_assignments" && created.some((r: Row) => violatesKey(store[table], r))) {
          return { data: null, error: UNIQUE_KEY_ERROR };
        }
        store[table].push(...created);
        return { data: created.map((r: Row) => ({ ...r })), error: null };
      }
      const matched = store[table].filter((r) => preds.every((p) => p(r)));
      if (mode === "update") {
        if (table === "job_assignments" && matched.some((r) => violatesKey(store[table], { ...r, ...payload }, r.id))) {
          return { data: null, error: UNIQUE_KEY_ERROR };
        }
        for (const r of matched) Object.assign(r, payload);
        return { data: matched.map((r) => ({ ...r })), error: null };
      }
      if (mode === "delete") {
        const ids = new Set(matched.map((r) => r.id));
        store[table] = store[table].filter((r) => !ids.has(r.id));
        return { data: matched.map((r) => ({ ...r })), error: null };
      }
      return { data: matched.map((r) => ({ ...r })), error: null };
    };
    const one = () => {
      const { data, error } = exec();
      return Promise.resolve({ data: Array.isArray(data) ? data[0] ?? null : data, error });
    };
    const b: any = {
      select: () => b,
      insert: (r: any) => {
        mode = "insert";
        payload = r;
        return b;
      },
      update: (r: any) => {
        mode = "update";
        payload = r;
        return b;
      },
      delete: () => {
        mode = "delete";
        return b;
      },
      eq: (k: string, v: any) => {
        preds.push((r) => r[k] === v);
        return b;
      },
      neq: (k: string, v: any) => {
        preds.push((r) => r[k] !== v);
        return b;
      },
      in: (k: string, arr: any[]) => {
        preds.push((r) => arr.includes(r[k]));
        return b;
      },
      or: (expr: string) => {
        const terms = String(expr).split(",").map((t) => t.trim()).filter(Boolean);
        preds.push((r) =>
          terms.some((term) => {
            const [col, op, ...rest] = term.split(".");
            const val = rest.join(".");
            if (op === "is" && val === "null") return r[col] == null;
            if (op === "neq") return r[col] != null && String(r[col]) !== val;
            if (op === "eq") return r[col] != null && String(r[col]) === val;
            throw new Error(`memory client: unsupported or() term ${term}`);
          })
        );
        return b;
      },
      order: () => b,
      limit: () => b,
      range: () => b,
      single: one,
      maybeSingle: one,
      then: (resolve: any, reject?: any) => Promise.resolve(exec()).then(resolve, reject),
    };
    return b;
  }
  return { from };
}

function stubFetch() {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = ((input: Request | URL | string) => {
    calls.push(input instanceof Request ? input.url : String(input));
    return Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }));
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

const WATCHER_ID = "watcher-everything";
// The watcher who sees every job type.
const WATCHER_EMAIL = GHOST_WATCHERS.find((w) => w.jobTypes === null)!.email;

function realStore(jobStatus = "accepted"): Store {
  return {
    users: [
      { id: WATCHER_ID, role: "ops_manager", name: "Watcher", email: WATCHER_EMAIL, phone: "0400000001" },
      { id: TRADE.id, role: "installer", name: "Sam Trade", email: "sam@example.test", phone: "0400000002" },
    ],
    jobs: [{ ...LIVE_JOB, status: jobStatus, ghl_opportunity_id: null }],
    job_assignments: [],
    job_events: [],
    makesafe_job_details: [],
  };
}

function realDeps(store: Store, over: Partial<any> = {}) {
  const client = memoryClient(store);
  return {
    client,
    book: {
      today: TODAY,
      bookingEnabled: () => Promise.resolve(true),
      findOwnRows: async (jobId: string, userId: string, days: string[]) => {
        const { data } = await client.from("job_assignments").select("*").eq("job_id", jobId).eq("user_id", userId)
          .in("scheduled_date", days);
        return data || [];
      },
      createAssignment: (body: any) => createAssignment(client, body),
      isUserDateConflict: (e: any) => String(e?.code || "") === "23505",
      notSchedulableStatuses: _MAKESAFE_POOL_EXCLUDED_STATUSES,
      ...over,
    },
    unbook: {
      today: TODAY,
      bookingEnabled: () => Promise.resolve(true),
      deleteAssignment: (body: any) => deleteAssignment(client, body),
    },
  };
}

const realTest = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

realTest("real createAssignment: a future self-booking is an ordinary install row, sends no text, moves an accepted job to processing and mirrors the watcher", async () => {
  const net = stubFetch();
  try {
    const store = realStore("accepted");
    const d = realDeps(store);
    const res = await selfBookJob(d.client, { body: { job_id: "job-1", dates: ["2026-11-20"] }, trade: TRADE }, d.book);
    await flush();
    assertEquals(res.bookings.map((b) => b.mode), ["created"]);
    const own = store.job_assignments.filter((r) => r.user_id === TRADE.id);
    assertEquals(own.length, 1);
    assertEquals(
      [own[0].assignment_type, own[0].status, own[0].confirmation_status, own[0].notes, own[0].scheduled_date, own[0].is_ghost],
      ["install", "confirmed", "confirmed", "Added themselves in the app", "2026-11-20", false],
    );
    assert(own[0].acknowledged_at, "accepted by the trade who made it");
    // No text to anyone: the only outbound calls are not the SMS proxy.
    assertEquals(net.calls.filter((u) => /send_sms/.test(u)), []);
    // The side effects the owner is told about.
    assertEquals(store.jobs[0].status, "processing", "an accepted job moves to processing, as for any allocation");
    const ghosts = store.job_assignments.filter((r) => r.is_ghost === true);
    assertEquals(ghosts.map((g) => [g.user_id, g.scheduled_date, g.role]), [[WATCHER_ID, "2026-11-20", "observer"]]);
    const types = store.job_events.map((e) => e.event_type);
    assert(types.includes("assignment_created"));
    assert(types.includes("trade_self_allocated"));
  } finally {
    net.restore();
  }
});

realTest("real createAssignment: a cancelled own row on the key is brought back in place (one row, no 23505), a used one refuses", async () => {
  const net = stubFetch();
  try {
    const store = realStore("scheduled");
    store.job_assignments.push({
      id: "asn-cancelled",
      job_id: "job-1",
      user_id: TRADE.id,
      scheduled_date: "2026-11-20",
      status: "cancelled",
      is_ghost: false,
      is_lead: true,
      role: "lead_installer",
      assignment_type: "install",
      notes: "Booked by the office",
      acknowledged_at: "2026-11-01T00:00:00Z",
    });
    const d = realDeps(store);
    const res = await selfBookJob(d.client, { body: { job_id: "job-1", dates: ["2026-11-20"] }, trade: TRADE }, d.book);
    await flush();
    assertEquals(res.bookings.map((b) => [b.mode, b.assignment.id]), [["revived", "asn-cancelled"]]);
    const own = store.job_assignments.filter((r) => r.user_id === TRADE.id);
    assertEquals(own.length, 1, "still one row on the key");
    assertEquals(
      [own[0].id, own[0].status, own[0].notes, own[0].is_lead],
      ["asn-cancelled", "confirmed", "Added themselves in the app", false],
    );
    // and it can be taken off again, because the event names it as self-made
    const gone = await selfUnbookJob(d.client, { body: { assignment_id: "asn-cancelled" }, trade: TRADE }, d.unbook);
    await flush();
    assertEquals(gone.ok, true);
    assertEquals(store.job_assignments.filter((r) => r.user_id === TRADE.id).length, 0);

    // a blind insert over a cancelled row is what the key refuses
    store.job_assignments.push({
      id: "asn-used",
      job_id: "job-1",
      user_id: TRADE.id,
      scheduled_date: "2026-11-21",
      status: "cancelled",
      is_ghost: false,
      invoiced_in: "inv-1",
    });
    const err = await refusal(() =>
      selfBookJob(d.client, { body: { job_id: "job-1", dates: ["2026-11-21"] }, trade: TRADE }, d.book)
    );
    assertEquals(err.code, "self_book_conflict");
    assertEquals(store.job_assignments.find((r) => r.id === "asn-used")?.status, "cancelled");
  } finally {
    net.restore();
  }
});

realTest("real createAssignment: a watcher booking themselves has their ghost on that key released first", async () => {
  const net = stubFetch();
  try {
    const store = realStore("scheduled");
    // Another trade's booking minted the watcher's ghost for the day.
    await createAssignment(memoryClient(store), { jobId: "job-1", userId: TRADE.id, scheduledDate: "2026-11-20" });
    await flush();
    assertEquals(store.job_assignments.filter((r) => r.user_id === WATCHER_ID && r.is_ghost === true).length, 1);
    const d = realDeps(store);
    const res = await selfBookJob(d.client, {
      body: { job_id: "job-1", dates: ["2026-11-20"] },
      trade: { id: WATCHER_ID, orgId: "org-1", name: "Watcher" },
    }, d.book);
    await flush();
    assertEquals(res.bookings.map((b) => b.mode), ["created"]);
    const rows = store.job_assignments.filter((r) => r.user_id === WATCHER_ID);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].is_ghost, false, "the real booking holds the key, the ghost is gone");
  } finally {
    net.restore();
  }
});

realTest("real deleteAssignment: taking the last booking off a day removes the watcher's ghost for it", async () => {
  const net = stubFetch();
  try {
    const store = realStore("scheduled");
    const d = realDeps(store);
    const res = await selfBookJob(d.client, { body: { job_id: "job-1", dates: ["2026-11-20", "2026-11-21"] }, trade: TRADE }, d.book);
    await flush();
    assertEquals(store.job_assignments.filter((r) => r.is_ghost === true).length, 2);
    await selfUnbookJob(d.client, { body: { assignment_id: res.bookings[0].assignment.id }, trade: TRADE }, d.unbook);
    await flush();
    assertEquals(
      store.job_assignments.map((r) => [r.user_id, r.scheduled_date, r.is_ghost]).sort(),
      [[TRADE.id, "2026-11-21", false], [WATCHER_ID, "2026-11-21", true]].sort(),
    );
    const types = store.job_events.map((e) => e.event_type);
    assert(types.includes("assignment_deleted"));
    assert(types.includes("trade_self_unbooked"));
  } finally {
    net.restore();
  }
});

// ── 3. The front door ───────────────────────────────────────────────────────

const DOOR_TRADE = "7d4f0a52-0000-4000-8000-0000000b00c1";
const DOOR_ORG = "00000000-0000-0000-0000-000000000001";
const DOOR_JOB = "7d4f0a52-0000-4000-8000-0000000b00d1";

async function callDoor(
  action: string,
  body: Record<string, unknown>,
  opts: { flagOn?: boolean; method?: string } = {},
): Promise<{ status: number; body: any; tables: string[]; writes: string[] }> {
  const tables: string[] = [];
  const writes: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const accept = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("accept") || "";
    const reply = (rows: any[]) => {
      if (!accept.includes("vnd.pgrst.object")) return Promise.resolve(Response.json(rows));
      if (rows.length === 1) return Promise.resolve(Response.json(rows[0]));
      return Promise.resolve(Response.json({ code: "PGRST116", message: "no rows" }, { status: 406 }));
    };
    if (url.pathname.startsWith("/auth/v1/user")) {
      return Promise.resolve(Response.json({ id: DOOR_TRADE, email: "", aud: "authenticated" }));
    }
    const table = url.pathname.match(/^\/rest\/v1\/(.+)$/)?.[1] || "";
    if (table) tables.push(table);
    if (method !== "GET" && method !== "HEAD") writes.push(`${method} ${table}`);
    if (table === "users") {
      return reply([{
        id: DOOR_TRADE,
        org_id: DOOR_ORG,
        role: "installer",
        name: "Door Trade",
        managed_verticals: [],
        trade_sees_all_jobs: false,
      }]);
    }
    if (table === "feature_flags") {
      const name = url.searchParams.get("flag_name") || "";
      return reply(opts.flagOn && name === "eq.trade_self_booking_v1" ? [{ enabled: true }] : []);
    }
    return reply([]);
  }) as typeof fetch;
  try {
    const url = new URL("https://example.invalid/ops-api");
    url.searchParams.set("action", action);
    const method = opts.method ?? "POST";
    const res = await _opsApiRequestHandlerForTest(
      new Request(url, {
        method,
        headers: { authorization: "Bearer trade-jwt", "content-type": "application/json" },
        body: method === "GET" ? undefined : JSON.stringify(body),
      }),
    );
    const text = await res.text();
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    return { status: res.status, body: parsed, tables, writes };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

for (const [action, body] of [
  ["self_book_job", { job_id: DOOR_JOB, dates: ["2099-01-01"] }],
  ["self_unbook_job", { assignment_id: "7d4f0a52-0000-4000-8000-0000000b00e1" }],
] as Array<[string, Record<string, unknown>]>) {
  realTest(`${action}: a plain trade passes the front door; switch off answers 409 self_booking_disabled and writes nothing`, async () => {
    const out = await callDoor(action, body);
    assert(out.body.code !== "operator_access_required", JSON.stringify(out.body));
    assertEquals(out.status, 409, JSON.stringify(out.body));
    assertEquals(out.body.ok, false);
    assertEquals(out.body.code, "self_booking_disabled");
    assert(typeof out.body.error === "string" && out.body.error.length > 10);
    assertEquals(out.writes, []);
    assertEquals(out.tables.filter((t) => t !== "users" && t !== "feature_flags"), [], "no job or booking is read");
  });

  realTest(`${action}: GET is refused 405`, async () => {
    const out = await callDoor(action, body, { method: "GET" });
    assertEquals(out.status, 405, JSON.stringify(out.body));
    assertEquals(out.writes, []);
  });
}

realTest("self_book_job: switch on, the route applies the rules (a date past the cap, a job outside the company) before any write", async () => {
  const far = await callDoor("self_book_job", { job_id: DOOR_JOB, dates: ["2099-01-01"] }, { flagOn: true });
  assertEquals([far.status, far.body.code], [400, "self_book_date_too_far"], JSON.stringify(far.body));
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const none = await callDoor("self_book_job", { job_id: DOOR_JOB, dates: [today], user_id: "someone-else" }, { flagOn: true });
  assertEquals([none.status, none.body.code], [404, "self_book_job_not_found"], JSON.stringify(none.body));
  assertEquals(none.writes, []);
  const gone = await callDoor("self_unbook_job", { assignment_id: "7d4f0a52-0000-4000-8000-0000000b00e1" }, { flagOn: true });
  assertEquals([gone.status, gone.body.code], [404, "self_unbook_not_found"], JSON.stringify(gone.body));
  assertEquals(gone.writes, []);
});
