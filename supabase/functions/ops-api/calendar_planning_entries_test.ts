// deno-lint-ignore-file no-explicit-any
// Calendar planning entries + recurring series (ops-api).
// ---------------------------------------------------------------------------
// The Add Event modal posts create_assignment with no jobId and an optional
// recurrence_rule. Before this, createAssignment threw "jobId and
// scheduledDate required" for every job-less entry, never stored the label,
// and ignored the rule; delete_recurring_events / update_recurring_events did
// not exist. Drives the REAL exported functions against a fake PostgREST
// client that records each write and its filters.
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createAssignment, createPlanningEntries, deleteRecurringEvents, updateRecurringEvents } from "./index.ts";

type Call = { table: string; op: string; payload: any; filters: Array<[string, string, any]> };

function fakeClient(opts: { anchors?: Record<string, any> } = {}) {
  const calls: Call[] = [];
  function builder(table: string) {
    const call: Call = { table, op: "select", payload: null, filters: [] };
    const result = () => {
      if (call.op === "insert") {
        const rows = Array.isArray(call.payload) ? call.payload : [call.payload];
        return rows.map((r: any, i: number) => ({ id: `${table}-${i + 1}`, ...r }));
      }
      if (call.op === "delete" || call.op === "update") return [{ id: "x1" }, { id: "x2" }];
      return [];
    };
    const b: any = {
      select: () => b,
      insert: (p: any) => { call.op = "insert"; call.payload = p; calls.push(call); return b; },
      update: (p: any) => { call.op = "update"; call.payload = p; calls.push(call); return b; },
      delete: () => { call.op = "delete"; calls.push(call); return b; },
      eq: (k: string, v: any) => { call.filters.push(["eq", k, v]); return b; },
      gte: (k: string, v: any) => { call.filters.push(["gte", k, v]); return b; },
      in: (k: string, v: any) => { call.filters.push(["in", k, v]); return b; },
      neq: () => b, order: () => b, limit: () => b,
      maybeSingle: () => {
        const id = call.filters.find((f) => f[1] === "id")?.[2];
        return Promise.resolve({ data: opts.anchors?.[id] ?? null, error: null });
      },
      single: () => Promise.resolve({ data: result()[0] ?? null, error: null }),
      then: (res: any, rej: any) => Promise.resolve({ data: result(), error: null }).then(res, rej),
      catch: () => Promise.resolve({ data: null, error: null }),
    };
    return b;
  }
  return { client: { from: (t: string) => builder(t) }, calls };
}

const assignmentInserts = (calls: Call[]) =>
  calls.filter((c) => c.table === "job_assignments" && c.op === "insert");

// What ops.html submitAddEvent sends for a weekly meeting.
const weeklyMeeting = {
  jobId: null, scheduledDate: "2026-10-06", scheduledEnd: null,
  startTime: "09:00", endTime: "10:00", assignmentType: "meeting",
  crewName: "Shaun", userId: "user-shaun", role: "lead_installer", notes: null,
  label: "Build Meeting - Shaun, Marnin", visible_to_trades: false,
  recurrence_rule: { freq: "weekly", interval: 1, endType: "count", endCount: 4 },
  confirmationStatus: "tentative",
};

Deno.test("create_assignment: a repeating job-less meeting becomes one row per week sharing a group id", async () => {
  const { client, calls } = fakeClient();
  const res: any = await createAssignment(client, weeklyMeeting);
  const inserts = assignmentInserts(calls);
  assertEquals(inserts.length, 1, "one bulk insert");
  const rows = inserts[0].payload;
  assertEquals(rows.map((r: any) => r.scheduled_date), ["2026-10-06", "2026-10-13", "2026-10-20", "2026-10-27"]);
  assert(res.recurrence_group_id, "group id returned");
  for (const r of rows) {
    assertEquals(r.recurrence_group_id, res.recurrence_group_id);
    assertEquals(r.label, "Build Meeting - Shaun, Marnin");
    assertEquals(r.job_id, null);
    assertEquals(r.start_time, "09:00");
    assertEquals(r.assignment_type, "meeting");
    assertEquals(r.confirmation_status, "tentative");
  }
  assertEquals(res.count, 4);
  assertEquals(calls.filter((c) => c.table === "jobs").length, 0, "no job read or status change");
});

Deno.test("create_assignment: a single job-less meeting is created (was 'jobId and scheduledDate required')", async () => {
  const { client, calls } = fakeClient();
  const res: any = await createAssignment(client, { ...weeklyMeeting, recurrence_rule: null });
  const rows = assignmentInserts(calls)[0].payload;
  assertEquals(rows.length, 1);
  assertEquals(rows[0].label, "Build Meeting - Shaun, Marnin");
  assertEquals(rows[0].recurrence_group_id, null);
  assertEquals(res.assignment.label, "Build Meeting - Shaun, Marnin");
});

Deno.test("create_assignment: multi-day entries keep their length on every occurrence", async () => {
  const { client, calls } = fakeClient();
  await createPlanningEntries(client, {
    ...weeklyMeeting, scheduledDate: "2026-10-05", scheduledEnd: "2026-10-06",
    recurrence_rule: { freq: "weekly", endType: "count", endCount: 2 },
  });
  const rows = assignmentInserts(calls)[0].payload;
  assertEquals(rows.map((r: any) => [r.scheduled_date, r.scheduled_end]), [
    ["2026-10-05", "2026-10-06"], ["2026-10-12", "2026-10-13"],
  ]);
});

Deno.test("create_assignment: refuses a job-less entry with no title, a repeating crew job, and a bad rule", async () => {
  await assertRejects(() => createAssignment(fakeClient().client, { ...weeklyMeeting, label: "  " }), Error, "title");
  await assertRejects(
    () => createAssignment(fakeClient().client, { ...weeklyMeeting, jobId: "job-1", assignmentType: "install" }),
    Error,
    "Only meetings and reminders can repeat",
  );
  await assertRejects(
    () => createAssignment(fakeClient().client, { ...weeklyMeeting, recurrence_rule: { freq: "fortnightly" } }),
    Error,
    "Unknown repeat frequency",
  );
  await assertRejects(
    () => createAssignment(fakeClient().client, { ...weeklyMeeting, userId: null, assignmentType: "install", recurrence_rule: null }),
    Error,
    "real crew member",
  );
});

const ANCHORS = {
  "asg-3": { id: "asg-3", recurrence_group_id: "grp-1", scheduled_date: "2026-10-20" },
  "asg-other": { id: "asg-other", recurrence_group_id: "grp-2", scheduled_date: "2026-10-20" },
};

Deno.test("delete_recurring_events: this and future = same group, on or after the clicked date, meetings only", async () => {
  const { client, calls } = fakeClient({ anchors: ANCHORS });
  const res: any = await deleteRecurringEvents(client, {
    recurrence_group_id: "grp-1", scope: "this_and_future", event_id: "asg-3", event_type: "assignment",
  });
  const del = calls.find((c) => c.op === "delete")!;
  assertEquals(del.table, "job_assignments");
  assert(del.filters.some((f) => f[0] === "eq" && f[1] === "recurrence_group_id" && f[2] === "grp-1"));
  assert(del.filters.some((f) => f[0] === "gte" && f[1] === "scheduled_date" && f[2] === "2026-10-20"));
  assert(del.filters.some((f) => f[0] === "in" && f[1] === "assignment_type" && f[2].includes("meeting")));
  assertEquals(res.deleted, 2);
});

Deno.test("delete_recurring_events: 'this' deletes only the clicked row; 'all' needs no event", async () => {
  const one = fakeClient({ anchors: ANCHORS });
  await deleteRecurringEvents(one.client, { recurrence_group_id: "grp-1", scope: "this", event_id: "asg-3" });
  const del1 = one.calls.find((c) => c.op === "delete")!;
  assert(del1.filters.some((f) => f[1] === "id" && f[2] === "asg-3"));

  const all = fakeClient();
  await deleteRecurringEvents(all.client, { recurrence_group_id: "grp-1", scope: "all" });
  const del2 = all.calls.find((c) => c.op === "delete")!;
  assert(!del2.filters.some((f) => f[1] === "id" || f[0] === "gte"));
});

Deno.test("delete_recurring_events: org events filter on event_date + org, not assignment type", async () => {
  const { client, calls } = fakeClient({
    anchors: { "ev-1": { id: "ev-1", recurrence_group_id: "grp-h", event_date: "2026-12-25" } },
  });
  await deleteRecurringEvents(client, {
    recurrence_group_id: "grp-h", scope: "this_and_future", event_id: "ev-1", event_type: "org_event",
  });
  const del = calls.find((c) => c.op === "delete")!;
  assertEquals(del.table, "org_events");
  assert(del.filters.some((f) => f[0] === "gte" && f[1] === "event_date" && f[2] === "2026-12-25"));
  assert(!del.filters.some((f) => f[1] === "assignment_type"));
});

Deno.test("delete_recurring_events: refuses an event from another series, a missing event and a bad scope", async () => {
  await assertRejects(
    () => deleteRecurringEvents(fakeClient({ anchors: ANCHORS }).client, { recurrence_group_id: "grp-1", scope: "this", event_id: "asg-other" }),
    Error, "not part of this series",
  );
  await assertRejects(
    () => deleteRecurringEvents(fakeClient().client, { recurrence_group_id: "grp-1", scope: "this", event_id: "nope" }),
    Error, "not found",
  );
  await assertRejects(
    () => deleteRecurringEvents(fakeClient().client, { recurrence_group_id: "grp-1", scope: "everything" }),
    Error, "scope must be",
  );
});

Deno.test("update_recurring_events: changes allowed fields across the series, refuses dates", async () => {
  const { client, calls } = fakeClient({ anchors: ANCHORS });
  const res: any = await updateRecurringEvents(client, {
    recurrence_group_id: "grp-1", scope: "this_and_future", event_id: "asg-3",
    updates: { start_time: "14:00", end_time: "15:00" },
  });
  const upd = calls.find((c) => c.op === "update")!;
  assertEquals(upd.payload, { start_time: "14:00", end_time: "15:00" });
  assert(upd.filters.some((f) => f[0] === "gte" && f[1] === "scheduled_date"));
  assertEquals(res.updated, 2);

  await assertRejects(
    () => updateRecurringEvents(fakeClient({ anchors: ANCHORS }).client, {
      recurrence_group_id: "grp-1", scope: "all", updates: { scheduled_date: "2026-11-01" },
    }),
    Error, "Cannot change scheduled_date",
  );
});
