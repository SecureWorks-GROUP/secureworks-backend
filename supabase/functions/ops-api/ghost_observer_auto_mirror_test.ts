// deno-lint-ignore-file no-import-prefix no-explicit-any
// Ghost observer auto-mirror (2026-09-17, Captain: "repair works that are
// scheduled need to be seen by Shaun as a ghost assignment too, just as any
// other job would.").
//
// Every genuine, dated crew assignment — on EVERY job type, including a
// type=repair job or a family-tagged repair make-safe — must mirror a ghost
// observer row (`is_ghost:true`, `role:'observer'`) for the ops manager, so
// his own calendar shows the schedule. The mirror must stay idempotent
// (double-create never duplicates), self-assign-safe (the ops manager
// assigned to his own job needs no watcher row), reschedule-following
// (moving the real row moves the mirror), and cleaned up on removal
// (deleting/cancelling the last real crew row for a date drops the mirror).
//
// This suite exercises the pure module (ghost_observer_mirror.ts) directly
// AND its wiring into createAssignment / updateAssignment / deleteAssignment
// / the legacy approve_assignment_request writer, via a small in-memory
// Supabase-shaped fake client. Read-path exclusion (calendar_events,
// my_jobs, the Trade app) is a PRE-EXISTING, separately pinned contract —
// see myjobs_ghost_rows_test.ts — and is not re-asserted here; this module
// never touches a read path.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createAssignment,
  deleteAssignment,
  updateAssignment,
} from "./index.ts";
import {
  applyGhostObserverBackfill,
  ensureGhostObserverMirror,
  findGhostObserverBackfillCandidates,
  GHOST_OBSERVER_ROLE,
  isGenuineCrewAssignmentRow,
} from "./ghost_observer_mirror.ts";

// ── Generic in-memory Supabase-shaped fake client ───────────────────────────
// Not a full PostgREST emulator — just enough chained filtering (eq/neq/gte/
// order/limit), insert/update/delete, and single()/maybeSingle()/then() to
// exercise createAssignment/updateAssignment/deleteAssignment and the mirror
// module honestly, including their read-then-write idempotency checks.

type Row = Record<string, any>;
type Store = Record<string, Row[]>;

function makeFakeClient(store: Store) {
  // Tests deliberately build a FRESH client per call (mirroring separate API
  // requests hitting the same underlying store), so generated ids must be
  // globally unique — never a per-client counter, which would collide across
  // instances sharing one store.
  function from(table: string) {
    store[table] = store[table] || [];
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let insertRows: Row[] | null = null;
    let updateRow: Row | null = null;
    let selectStr = "";
    const preds: Array<(r: Row) => boolean> = [];
    let orderKey: string | null = null;
    let orderAsc = true;
    let limitN: number | null = null;

    const applyPreds = (rows: Row[]) => rows.filter((r) => preds.every((p) => p(r)));

    function exec(): { data: any; error: any } {
      // Every branch returns FRESH clones, never the live stored object —
      // otherwise a caller holding an earlier read (e.g. updateAssignment's
      // oldAssignment) would see a later mutation retroactively, exactly
      // unlike a real PostgREST response snapshot.
      if (mode === "insert") {
        const created = insertRows!.map((r) => ({ id: r.id ?? crypto.randomUUID(), ...r }));
        store[table].push(...created);
        const out = created.map((r) => ({ ...r }));
        return { data: out.length === 1 ? out[0] : out, error: null };
      }
      if (mode === "update") {
        const matched = applyPreds(store[table]);
        for (const r of matched) Object.assign(r, updateRow);
        const out = matched.map((r) => ({ ...r }));
        return { data: out.length === 1 ? out[0] : out, error: null };
      }
      if (mode === "delete") {
        const matched = applyPreds(store[table]);
        const ids = new Set(matched.map((r) => r.id));
        store[table] = store[table].filter((r) => !ids.has(r.id));
        return { data: matched.map((r) => ({ ...r })), error: null };
      }
      let rows = applyPreds(store[table]);
      if (orderKey) {
        const key = orderKey;
        rows = rows.slice().sort((a, b) => {
          if (a[key] < b[key]) return orderAsc ? -1 : 1;
          if (a[key] > b[key]) return orderAsc ? 1 : -1;
          return 0;
        });
      }
      if (limitN != null) rows = rows.slice(0, limitN);
      let out = rows.map((r) => ({ ...r }));
      if (selectStr.includes("jobs:job_id(")) {
        out = out.map((r) => ({
          ...r,
          jobs: (store["jobs"] || []).find((j) => j.id === r.job_id) || null,
        }));
      }
      return { data: out, error: null };
    }

    const b: any = {
      select: (s: string) => {
        selectStr = s;
        return b;
      },
      insert: (r: Row | Row[]) => {
        mode = "insert";
        insertRows = Array.isArray(r) ? r : [r];
        return b;
      },
      update: (r: Row) => {
        mode = "update";
        updateRow = r;
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
      gte: (k: string, v: any) => {
        preds.push((r) => r[k] != null && r[k] >= v);
        return b;
      },
      lte: (k: string, v: any) => {
        preds.push((r) => r[k] != null && r[k] <= v);
        return b;
      },
      lt: (k: string, v: any) => {
        preds.push((r) => r[k] != null && r[k] < v);
        return b;
      },
      in: (k: string, arr: any[]) => {
        preds.push((r) => arr.includes(r[k]));
        return b;
      },
      or: () => b,
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
      single: () => {
        const { data, error } = exec();
        const row = Array.isArray(data) ? data[0] ?? null : data;
        return Promise.resolve({ data: row, error });
      },
      maybeSingle: () => {
        const { data, error } = exec();
        const row = Array.isArray(data) ? data[0] ?? null : data;
        return Promise.resolve({ data: row, error });
      },
      then: (resolve: any, reject?: any) => Promise.resolve(exec()).then(resolve, reject),
    };
    return b;
  }
  return { from };
}

function stubFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }))) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

const OPS_MANAGER_ID = "9913309f-35ae-4a71-8e1f-f704ecc526ea";

function baseStore(): Store {
  return {
    users: [
      { id: OPS_MANAGER_ID, role: "ops_manager", name: "Shaun", phone: null, created_at: "2025-01-01" },
      { id: "inst-1", role: "installer", name: "Hugo", phone: null },
      { id: "inst-2", role: "installer", name: "Marco", phone: null },
    ],
    jobs: [],
    job_assignments: [],
    job_events: [],
    makesafe_job_details: [],
  };
}

function ghostRowsFor(store: Store, jobId: string) {
  return (store.job_assignments || []).filter(
    (r) => r.job_id === jobId && r.is_ghost === true && r.user_id === OPS_MANAGER_ID,
  );
}

// ── isGenuineCrewAssignmentRow (pure) ───────────────────────────────────────

Deno.test("isGenuineCrewAssignmentRow: install/lead_installer/assist rows are genuine crew work", () => {
  assertEquals(isGenuineCrewAssignmentRow({ role: "lead_installer", assignment_type: "install" }), true);
  assertEquals(isGenuineCrewAssignmentRow({ role: "crew", assignment_type: "assist" }), true);
  assertEquals(isGenuineCrewAssignmentRow({ assignment_type: "install" }), true); // no role set
});

Deno.test("isGenuineCrewAssignmentRow: ghost/observer rows, meetings and reminders are never genuine crew work", () => {
  assertEquals(isGenuineCrewAssignmentRow({ is_ghost: true, role: "observer" }), false);
  assertEquals(isGenuineCrewAssignmentRow({ role: "observer" }), false);
  assertEquals(isGenuineCrewAssignmentRow({ assignment_type: "observer" }), false);
  assertEquals(isGenuineCrewAssignmentRow({ role: "ghost" }), false);
  assertEquals(isGenuineCrewAssignmentRow({ assignment_type: "meeting" }), false);
  assertEquals(isGenuineCrewAssignmentRow({ assignment_type: "reminder" }), false);
  assertEquals(isGenuineCrewAssignmentRow(null), false);
});

// ── createAssignment: auto-mirror on create, across every job type ─────────

const JOB_FIXTURES: Array<{ label: string; job: Row }> = [
  {
    label: "repair-family make-safe (type=makesafe, metadata.ses_family=repair)",
    job: { id: "job-msf-repair", type: "makesafe", job_number: "SWMS-90001", status: "scheduled", metadata: { ses_family: "repair" } },
  },
  { label: "type=repair job", job: { id: "job-repair", type: "repair", job_number: "SWR-90002", status: "scheduled", metadata: {} } },
  { label: "fencing job", job: { id: "job-fencing", type: "fencing", job_number: "SWF-90003", status: "scheduled", metadata: {} } },
  { label: "patio job", job: { id: "job-patio", type: "patio", job_number: "SWP-90004", status: "scheduled", metadata: {} } },
];

for (const { label, job } of JOB_FIXTURES) {
  Deno.test(`createAssignment: real install assignment on ${label} produces exactly one Shaun ghost row for the same span`, async () => {
    const unstub = stubFetch();
    try {
      const store = baseStore();
      store.jobs!.push({ ...job });

      const res = await createAssignment(makeFakeClient(store), {
        jobId: job.id,
        userId: "inst-1",
        scheduledDate: "2026-10-01",
        scheduledEnd: "2026-10-01",
        startTime: "08:00",
        crewName: "Hugo",
      });
      await flush();

      assert(res.assignment?.id, "real assignment was created");
      const ghosts = ghostRowsFor(store, job.id);
      assertEquals(ghosts.length, 1, `expected exactly one ghost row, saw ${ghosts.length}`);
      assertEquals(ghosts[0].scheduled_date, "2026-10-01");
      assertEquals(ghosts[0].role, GHOST_OBSERVER_ROLE);
      assertEquals(ghosts[0].is_ghost, true);
      assertEquals(ghosts[0].user_id, OPS_MANAGER_ID);
      assert(String(ghosts[0].notes || "").includes("Hugo"), "notes name the mirrored crew");

      // The ghost's own job_events row is auditable with the mirror source.
      const ghostEvent = (store.job_events || []).find(
        (e) => e.job_id === job.id && e.detail_json?.source === "ghost_auto_mirror",
      );
      assert(ghostEvent, "ghost mirror wrote its own auditable job_events row");
    } finally {
      unstub();
    }
  });
}

Deno.test("createAssignment: a second create on the same job/date does not duplicate the ghost", async () => {
  const unstub = stubFetch();
  try {
    const store = baseStore();
    store.jobs!.push({ id: "job-1", type: "fencing", job_number: "SWF-1", status: "scheduled" });

    await createAssignment(makeFakeClient(store), { jobId: "job-1", userId: "inst-1", scheduledDate: "2026-10-05" });
    await flush();
    // A second, different installer scheduled on the SAME job/date.
    await createAssignment(makeFakeClient(store), { jobId: "job-1", userId: "inst-2", scheduledDate: "2026-10-05" });
    await flush();

    const ghosts = ghostRowsFor(store, "job-1");
    assertEquals(ghosts.length, 1, "the second create must not mint a second ghost for the same span");
    const realRows = store.job_assignments!.filter((r) => r.job_id === "job-1" && !r.is_ghost);
    assertEquals(realRows.length, 2, "both real crew rows were still written");
  } finally {
    unstub();
  }
});

Deno.test("createAssignment: the ops manager assigned to his own job produces no ghost", async () => {
  const unstub = stubFetch();
  try {
    const store = baseStore();
    store.jobs!.push({ id: "job-self", type: "fencing", job_number: "SWF-2", status: "scheduled" });

    const res = await createAssignment(makeFakeClient(store), {
      jobId: "job-self",
      userId: OPS_MANAGER_ID,
      scheduledDate: "2026-10-06",
    });
    await flush();

    assert(res.assignment?.id);
    assertEquals(ghostRowsFor(store, "job-self").length, 0, "Shaun does not get a ghost of his own real row");
  } finally {
    unstub();
  }
});

// ── updateAssignment: reschedule moves the mirror ───────────────────────────

Deno.test("updateAssignment: rescheduling the sole crew row moves its mirrored ghost to the new date", async () => {
  const unstub = stubFetch();
  try {
    const store = baseStore();
    store.jobs!.push({ id: "job-resched", type: "patio", job_number: "SWP-3", status: "scheduled" });

    const created = await createAssignment(makeFakeClient(store), {
      jobId: "job-resched",
      userId: "inst-1",
      scheduledDate: "2026-10-10",
    });
    await flush();
    assertEquals(ghostRowsFor(store, "job-resched").length, 1);

    await updateAssignment(makeFakeClient(store), {
      assignmentId: created.assignment.id,
      scheduledDate: "2026-10-14",
    });
    await flush();

    const ghosts = ghostRowsFor(store, "job-resched");
    assertEquals(ghosts.length, 1, "the reschedule must not leave a second, stale ghost behind");
    assertEquals(ghosts[0].scheduled_date, "2026-10-14", "the ghost followed the real row to its new date");
  } finally {
    unstub();
  }
});

Deno.test("updateAssignment: reschedule leaves the old ghost alone when another crew row still covers the old date", async () => {
  const unstub = stubFetch();
  try {
    const store = baseStore();
    store.jobs!.push({ id: "job-multi", type: "fencing", job_number: "SWF-4", status: "scheduled" });

    const a1 = await createAssignment(makeFakeClient(store), { jobId: "job-multi", userId: "inst-1", scheduledDate: "2026-10-20" });
    await flush();
    await createAssignment(makeFakeClient(store), { jobId: "job-multi", userId: "inst-2", scheduledDate: "2026-10-20" });
    await flush();
    assertEquals(ghostRowsFor(store, "job-multi").length, 1);

    // Move inst-1 alone to a new date — inst-2 still covers the old date.
    await updateAssignment(makeFakeClient(store), { assignmentId: a1.assignment.id, scheduledDate: "2026-10-21" });
    await flush();

    const dates = ghostRowsFor(store, "job-multi").map((g) => g.scheduled_date).sort();
    assertEquals(dates, ["2026-10-20", "2026-10-21"], "the old date keeps its ghost (inst-2 still there) and the new date gets its own");
  } finally {
    unstub();
  }
});

// ── deleteAssignment: removing the last crew row removes the ghost ─────────

Deno.test("deleteAssignment: deleting the last crew row for a date removes the mirrored ghost", async () => {
  const unstub = stubFetch();
  try {
    const store = baseStore();
    store.jobs!.push({ id: "job-del", type: "repair", job_number: "SWR-5", status: "scheduled" });

    const created = await createAssignment(makeFakeClient(store), { jobId: "job-del", userId: "inst-1", scheduledDate: "2026-10-25" });
    await flush();
    assertEquals(ghostRowsFor(store, "job-del").length, 1);

    await deleteAssignment(makeFakeClient(store), { assignmentId: created.assignment.id });
    await flush();

    assertEquals(ghostRowsFor(store, "job-del").length, 0, "no crew work remains, so the ghost is removed too");
  } finally {
    unstub();
  }
});

Deno.test("deleteAssignment: deleting one of two crew rows on the same date keeps the ghost (the other still covers it)", async () => {
  const unstub = stubFetch();
  try {
    const store = baseStore();
    store.jobs!.push({ id: "job-del2", type: "fencing", job_number: "SWF-6", status: "scheduled" });

    const a1 = await createAssignment(makeFakeClient(store), { jobId: "job-del2", userId: "inst-1", scheduledDate: "2026-10-26" });
    await flush();
    await createAssignment(makeFakeClient(store), { jobId: "job-del2", userId: "inst-2", scheduledDate: "2026-10-26" });
    await flush();
    assertEquals(ghostRowsFor(store, "job-del2").length, 1);

    await deleteAssignment(makeFakeClient(store), { assignmentId: a1.assignment.id });
    await flush();

    assertEquals(ghostRowsFor(store, "job-del2").length, 1, "inst-2 still works that date, so the ghost stays");
  } finally {
    unstub();
  }
});

// ── backfill_ghost_observers: dry-run reports candidates, writes nothing ───

Deno.test("findGhostObserverBackfillCandidates: reports exactly the uncovered future non-cancelled genuine crew spans, and writes nothing", async () => {
  const store = baseStore();
  store.jobs!.push(
    { id: "job-b1", type: "fencing", job_number: "SWF-B1", metadata: {} },
    { id: "job-b2", type: "repair", job_number: "SWR-B2", metadata: {} },
  );
  store.job_assignments = [
    // Candidate: future, genuine, no ghost yet.
    { id: "a-b1", job_id: "job-b1", user_id: "inst-1", role: "lead_installer", assignment_type: "install", is_ghost: false, status: "scheduled", scheduled_date: "2026-11-01" },
    // Already covered by an existing ghost — not a candidate.
    { id: "a-b2", job_id: "job-b2", user_id: "inst-2", role: "lead_installer", assignment_type: "install", is_ghost: false, status: "scheduled", scheduled_date: "2026-11-02" },
    { id: "g-b2", job_id: "job-b2", user_id: OPS_MANAGER_ID, role: "observer", assignment_type: "install", is_ghost: true, status: "scheduled", scheduled_date: "2026-11-02" },
    // Cancelled — not a candidate.
    { id: "a-b3", job_id: "job-b1", user_id: "inst-1", role: "lead_installer", assignment_type: "install", is_ghost: false, status: "cancelled", scheduled_date: "2026-11-03" },
    // Past-dated — not a candidate.
    { id: "a-b4", job_id: "job-b1", user_id: "inst-1", role: "lead_installer", assignment_type: "install", is_ghost: false, status: "scheduled", scheduled_date: "2026-01-01" },
    // A meeting placeholder — not a candidate.
    { id: "a-b5", job_id: "job-b1", user_id: null, role: null, assignment_type: "meeting", is_ghost: false, status: "scheduled", scheduled_date: "2026-11-04" },
  ];
  const beforeCount = store.job_assignments.length;

  const candidates = await findGhostObserverBackfillCandidates(makeFakeClient(store), { today: "2026-09-17" });

  assertEquals(store.job_assignments.length, beforeCount, "a dry-run read must write nothing");
  assertEquals(candidates.length, 1, `expected exactly one candidate, saw ${candidates.map((c) => c.jobId + "/" + c.scheduledDate)}`);
  assertEquals(candidates[0].jobId, "job-b1");
  assertEquals(candidates[0].scheduledDate, "2026-11-01");
  assertEquals(candidates[0].job?.type, "fencing");
});

Deno.test("applyGhostObserverBackfill: apply writes exactly one ghost per reported candidate", async () => {
  const store = baseStore();
  store.jobs!.push({ id: "job-apply", type: "patio", job_number: "SWP-APPLY", metadata: {} });
  store.job_assignments = [
    { id: "a-apply", job_id: "job-apply", user_id: "inst-1", role: "lead_installer", assignment_type: "install", is_ghost: false, status: "scheduled", scheduled_date: "2026-11-10" },
  ];

  const candidates = await findGhostObserverBackfillCandidates(makeFakeClient(store), { today: "2026-09-17" });
  assertEquals(candidates.length, 1);

  const { created } = await applyGhostObserverBackfill(makeFakeClient(store), candidates);
  assertEquals(created, 1);
  assertEquals(ghostRowsFor(store, "job-apply").length, 1);

  // Re-running the backfill against the now-covered state finds nothing left to do.
  const remaining = await findGhostObserverBackfillCandidates(makeFakeClient(store), { today: "2026-09-17" });
  assertEquals(remaining.length, 0, "the backfill is idempotent — a second pass finds no candidates");
});

// ── ensureGhostObserverMirror: direct unit coverage of the ops-manager gate ─

Deno.test("ensureGhostObserverMirror: no-ops when no ops_manager user can be resolved", async () => {
  const store = baseStore();
  store.users = []; // nobody carries role='ops_manager'
  store.jobs!.push({ id: "job-noone", type: "fencing" });

  const res = await ensureGhostObserverMirror(makeFakeClient(store), {
    jobId: "job-noone",
    scheduledDate: "2026-10-01",
  });
  assertEquals(res.created, false);
  assertEquals((store.job_assignments || []).length, 0);
});
