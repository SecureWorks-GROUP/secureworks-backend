// deno-lint-ignore-file no-import-prefix no-explicit-any
// The 6am auto start (job_auto_start.ts): which jobs move from Scheduled to In Progress,
// the Perth day, the switch, the compare and set and the action door.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type AutoStartCandidate,
  type AutoStartDeps,
  autoStartLane,
  hasWorkBookingOn,
  isWorkBooking,
  JOB_AUTO_START_SOURCE,
  jobAutoStartSweep,
  loadJobAutoStartCandidates,
  perthToday,
  runJobAutoStartAction,
} from "./job_auto_start.ts";

// 22:00 UTC on 2 Nov is 06:00 on 3 Nov in Perth: the cron's own instant.
const CRON_INSTANT = new Date("2026-11-02T22:00:00Z");
const TODAY = "2026-11-03";
const YESTERDAY = "2026-11-02";
const TOMORROW = "2026-11-04";

function work(date: string, extra: Record<string, unknown> = {}) {
  return {
    role: "lead_installer",
    status: "scheduled",
    assignment_type: "install",
    is_ghost: false,
    scheduled_date: date,
    ...extra,
  };
}

function job(
  id: string,
  bookings: any[],
  extra: Record<string, unknown> = {},
  details: any = null,
): AutoStartCandidate {
  return {
    job: {
      id,
      job_number: `SWF-${id}`,
      type: "fencing",
      status: "scheduled",
      metadata: {},
      ...extra,
    },
    details,
    bookings,
  };
}

function harness(
  candidates: AutoStartCandidate[] | null,
  opts: {
    flag?: boolean | null;
    now?: Date;
    statusMove?: any;
    stageMove?: any;
  } = {},
) {
  const statusMoves: any[] = [];
  const stageMoves: any[] = [];
  const runs: any[] = [];
  const deps: AutoStartDeps = {
    now: () => opts.now ?? CRON_INSTANT,
    readFlag: () => Promise.resolve(opts.flag === undefined ? true : opts.flag),
    loadCandidates: () => Promise.resolve(candidates),
    moveJobStatus: (body) => {
      statusMoves.push(body);
      return Promise.resolve(opts.statusMove ?? { success: true });
    },
    moveRepairStage: (body) => {
      stageMoves.push(body);
      return Promise.resolve(opts.stageMove ?? { success: true });
    },
    recordRun: (row) => {
      runs.push(row);
      return Promise.resolve();
    },
  };
  return { deps, statusMoves, stageMoves, runs };
}

const LIVE = { dry_run: false };

Deno.test("perthToday reads the Perth day, not the UTC day", () => {
  assertEquals(perthToday(CRON_INSTANT), TODAY);
  assertEquals(perthToday(new Date("2026-11-02T15:59:59Z")), "2026-11-02");
  assertEquals(perthToday(new Date("2026-11-02T16:00:00Z")), "2026-11-03");
});

Deno.test("a job with a work booking today moves to in_progress by compare and set", async () => {
  const h = harness([job("1", [work(TODAY)])]);
  const out: any = await jobAutoStartSweep(h.deps, LIVE);
  assertEquals(h.statusMoves, [{
    jobId: "1",
    status: "in_progress",
    source: JOB_AUTO_START_SOURCE,
    expected_statuses: ["scheduled"],
  }]);
  assertEquals(out.moved_count, 1);
  assertEquals(out.moved_job_numbers, ["SWF-1"]);
  assertEquals(h.runs.length, 1);
  assertEquals(h.runs[0].run_on, TODAY);
  assertEquals(h.runs[0].outcome, "ok");
  assertEquals(h.runs[0].moved_job_numbers, ["SWF-1"]);
});

Deno.test("bookings only yesterday, or only tomorrow, do not move (no catch-up)", async () => {
  const h = harness([
    job("y", [work(YESTERDAY), work("2026-10-19")]),
    job("t", [work(TOMORROW)]),
    job("gap", [work(YESTERDAY), work(TOMORROW)]),
  ]);
  const out: any = await jobAutoStartSweep(h.deps, LIVE);
  assertEquals(h.statusMoves, []);
  assertEquals(out.results.map((r: any) => r.action), [
    "booked_earlier_only",
    "starts_later",
    "not_booked_today",
  ]);
});

Deno.test("a multi-day job still at Scheduled with an earlier booking and one today moves", async () => {
  // SWF-261308: bookings left on the calendar from 19 Oct, rebooked for today.
  const h = harness([
    job("m", [
      work("2026-10-19"),
      work(YESTERDAY, { status: "complete" }),
      work(TODAY),
      work(TOMORROW),
    ]),
  ]);
  await jobAutoStartSweep(h.deps, LIVE);
  assertEquals(h.statusMoves.length, 1);
});

Deno.test("one multi-day booking that spans today moves the job", async () => {
  const h = harness([
    job("s", [work(YESTERDAY, { scheduled_end: TOMORROW })]),
    // Fri 30 Oct to Mon 2 Nov paints Fri and Mon only: Tue 3 Nov is outside it.
    job("w", [work("2026-10-30", { scheduled_end: "2026-11-02" })]),
  ]);
  const out: any = await jobAutoStartSweep(h.deps, LIVE);
  assertEquals(h.statusMoves.map((m) => m.jobId), ["s"]);
  assertEquals(out.results[1].action, "booked_earlier_only");
});

Deno.test("a meeting, follow-up or ghost watcher row today is not a work day", async () => {
  const h = harness([
    job("meet", [work(TODAY, { assignment_type: "meeting" })]),
    job("scope", [work(TODAY, { assignment_type: "scope" })]),
    job("quote", [work(TODAY, { assignment_type: "quote" })]),
    job("ghost", [work(TODAY, { is_ghost: true, role: "observer" })]),
  ]);
  const out: any = await jobAutoStartSweep(h.deps, LIVE);
  assertEquals(h.statusMoves, []);
  assertEquals(
    out.results.map((r: any) => r.action),
    [
      "no_work_booking",
      "no_work_booking",
      "no_work_booking",
      "no_work_booking",
    ],
  );
});

Deno.test("an earlier visit that is not work does not matter", async () => {
  const h = harness([
    job("v", [work(YESTERDAY, { assignment_type: "meeting" }), work(TODAY)]),
  ]);
  await jobAutoStartSweep(h.deps, LIVE);
  assertEquals(h.statusMoves.length, 1);
});

Deno.test("a cancelled booking is ignored", async () => {
  // Cancelled yesterday, rebooked today.
  const moves = harness([
    job("r", [work(YESTERDAY, { status: "cancelled" }), work(TODAY)]),
  ]);
  await jobAutoStartSweep(moves.deps, LIVE);
  assertEquals(moves.statusMoves.length, 1);
  // Only a cancelled booking today: nothing to start.
  const none = harness([job("x", [work(TODAY, { status: "Cancelled" })])]);
  await jobAutoStartSweep(none.deps, LIVE);
  assertEquals(none.statusMoves, []);
});

Deno.test("a job not at Scheduled is untouched", async () => {
  const h = harness([
    job("ip", [work(TODAY)], { status: "in_progress" }),
    job("si", [work(TODAY)], { status: "schedule_install" }),
  ]);
  const out: any = await jobAutoStartSweep(h.deps, LIVE);
  assertEquals(h.statusMoves, []);
  assertEquals(out.results.map((r: any) => r.detail), [
    "not_scheduled",
    "not_scheduled",
  ]);
});

Deno.test("a job moved by hand meanwhile is reported, never forced", async () => {
  const h = harness([job("1", [work(TODAY)])], {
    statusMove: {
      success: false,
      skipped: "status_changed",
      status_seen: "in_progress",
    },
  });
  const out: any = await jobAutoStartSweep(h.deps, LIVE);
  assertEquals(out.moved_count, 0);
  assertEquals(out.results[0].action, "status_changed");
});

Deno.test("patio and other jobs.status types move the same way", async () => {
  const h = harness([job("p", [work(TODAY)], { type: "patio" })]);
  await jobAutoStartSweep(h.deps, LIVE);
  assertEquals(h.statusMoves.length, 1);
});

Deno.test("make-safe and restoration cards have no such stage and are skipped", async () => {
  const h = harness([
    job("ms", [work(TODAY)], { type: "makesafe" }),
    job("rs", [work(TODAY)], {
      type: "insurance",
      metadata: { insurance_job_type: "restoration" },
    }),
  ]);
  const out: any = await jobAutoStartSweep(h.deps, LIVE);
  assertEquals(h.statusMoves, []);
  assertEquals(out.results.map((r: any) => r.detail), [
    "make_safe_board",
    "make_safe_board",
  ]);
});

Deno.test("a repair moves its Repairs board stage to on_site, and its status when Scheduled", async () => {
  const h = harness([
    job("r1", [work(TODAY)], {
      type: "repair",
      status: "scheduled",
      metadata: { repair_stage: "scheduled" },
    }),
  ]);
  const out: any = await jobAutoStartSweep(h.deps, LIVE);
  assertEquals(h.stageMoves, [{
    job_id: "r1",
    stage: "on_site",
    expected_stages: ["scheduled"],
    source: JOB_AUTO_START_SOURCE,
  }]);
  assertEquals(h.statusMoves.length, 1);
  assertEquals(out.results[0].detail, "repair_stage_and_status");
});

Deno.test("a repair at board stage scheduled with another status moves its stage only", async () => {
  const h = harness([
    job("r2", [work(TODAY)], {
      type: "repair",
      status: "processing",
      metadata: { repair_stage: "scheduled" },
    }),
    // A family-tagged make-safe card is a repair; no stamp, status maps to scheduled.
    job("r3", [work(TODAY)], {
      type: "makesafe",
      status: "schedule_install",
      metadata: { makesafe_job_family: "repair" },
    }),
  ]);
  await jobAutoStartSweep(h.deps, LIVE);
  assertEquals(h.stageMoves.map((m) => m.job_id), ["r2", "r3"]);
  assertEquals(h.statusMoves, []);
});

Deno.test("a repair whose board stage is not scheduled is untouched", async () => {
  const h = harness([
    job("r4", [work(TODAY)], {
      type: "repair",
      status: "scheduled",
      metadata: { repair_stage: "complete" },
    }),
  ]);
  await jobAutoStartSweep(h.deps, LIVE);
  assertEquals(h.stageMoves, []);
  assertEquals(h.statusMoves, []);
});

Deno.test("a repair whose stage moved meanwhile is not moved further", async () => {
  const h = harness([
    job("r5", [work(TODAY)], {
      type: "repair",
      metadata: { repair_stage: "scheduled" },
    }),
  ], { stageMove: { success: false, skipped: "stage_changed" } });
  const out: any = await jobAutoStartSweep(h.deps, LIVE);
  assertEquals(h.statusMoves, []);
  assertEquals(out.results[0].action, "stage_changed");
});

Deno.test("the switch off, or unreadable, moves nothing and records nothing", async () => {
  for (const flag of [false, null]) {
    const h = harness([job("1", [work(TODAY)])], { flag });
    const out: any = await jobAutoStartSweep(h.deps, LIVE);
    assertEquals(out.ran, false);
    assertEquals(h.statusMoves, []);
    assertEquals(h.runs, []);
  }
});

Deno.test("a dry run (the default) moves nothing and records nothing", async () => {
  const h = harness([job("1", [work(TODAY)])]);
  const out: any = await jobAutoStartSweep(h.deps, {});
  assertEquals(out.dry_run, true);
  assertEquals(out.results[0].action, "would_move");
  assertEquals(h.statusMoves, []);
  assertEquals(h.runs, []);
});

Deno.test("the Perth day decides at the UTC boundary", async () => {
  // 15:59 UTC on 2 Nov is still 2 Nov in Perth; 16:00 UTC is 3 Nov.
  const before = harness([job("1", [work(TODAY)])], {
    now: new Date("2026-11-02T15:59:00Z"),
  });
  await jobAutoStartSweep(before.deps, LIVE);
  assertEquals(before.statusMoves, []);
  const after = harness([job("1", [work(TODAY)])], {
    now: new Date("2026-11-02T16:00:00Z"),
  });
  await jobAutoStartSweep(after.deps, LIVE);
  assertEquals(after.statusMoves.length, 1);
});

Deno.test("an unreadable candidate list moves nothing and records a failed run", async () => {
  const h = harness(null);
  const out: any = await jobAutoStartSweep(h.deps, LIVE);
  assertEquals(out.ok, false);
  assertEquals(h.runs[0].outcome, "failed");
});

Deno.test("one failed move is recorded and the rest still move", async () => {
  const h = harness([job("a", [work(TODAY)]), job("b", [work(TODAY)])]);
  let calls = 0;
  h.deps.moveJobStatus = (body) => {
    calls++;
    if (body.jobId === "a") return Promise.reject(new Error("boom"));
    return Promise.resolve({ success: true });
  };
  const out: any = await jobAutoStartSweep(h.deps, LIVE);
  assertEquals(calls, 2);
  assertEquals(out.moved_job_numbers, ["SWF-b"]);
  assertEquals(h.runs[0].outcome, "partial");
});

Deno.test("a repair whose stage moved but whose status move threw is recorded as moved", async () => {
  const h = harness([
    job("r6", [work(TODAY)], {
      type: "repair",
      status: "scheduled",
      metadata: { repair_stage: "scheduled" },
    }),
  ]);
  h.deps.moveJobStatus = () => Promise.reject(new Error("boom"));
  const out: any = await jobAutoStartSweep(h.deps, LIVE);
  assertEquals(h.stageMoves.length, 1);
  assertEquals(out.results[0].action, "moved");
  assertEquals(out.results[0].detail, "repair_stage_status_failed");
  assertEquals(out.moved_job_numbers, ["SWF-r6"]);
  assertEquals(h.runs[0].outcome, "ok");
});

/** A PostgREST stand-in that, like the server, never returns more than 1,000 rows. */
function cappedClient(
  tables: Record<string, any[]>,
  failAt: { table: string; from: number } | null = null,
) {
  return {
    from(table: string) {
      let ids: string[] | null = null;
      let ordered = false;
      let range: [number, number] | null = null;
      const builder: any = {
        select: () => builder,
        or: () => builder,
        in: (_col: string, values: string[]) => {
          ids = values;
          return builder;
        },
        order: () => {
          ordered = true;
          return builder;
        },
        range: (from: number, to: number) => {
          range = [from, to];
          return builder;
        },
        then: (resolve: (v: any) => unknown) => {
          if (failAt && failAt.table === table && range?.[0] === failAt.from) {
            return resolve({ data: null, error: { message: "page failed" } });
          }
          let rows = (tables[table] ?? []).filter((r) =>
            !ids || ids.includes(String(r.job_id ?? r.id))
          );
          if (ordered) {
            rows = [...rows].sort((a, b) =>
              String(a.id) < String(b.id) ? -1 : 1
            );
          }
          if (range) rows = rows.slice(range[0], range[1] + 1);
          return resolve({ data: rows.slice(0, 1000), error: null });
        },
      };
      return builder;
    },
  };
}

Deno.test("the candidate read pages every booking past the 1,000 row cap", async () => {
  const filler = Array.from({ length: 1200 }, (_, i) => ({
    id: `a${String(i).padStart(5, "0")}`,
    job_id: "busy",
    ...work(YESTERDAY),
  }));
  const client = cappedClient({
    jobs: [{
      id: "busy",
      job_number: "SWF-busy",
      type: "fencing",
      status: "scheduled",
      metadata: {},
    }],
    makesafe_job_details: [],
    job_assignments: [...filler, {
      id: "z99999",
      job_id: "busy",
      ...work(TODAY),
    }],
  });
  const candidates = await loadJobAutoStartCandidates(client);
  assertEquals(candidates?.[0].bookings.length, 1201);
  assertEquals(hasWorkBookingOn(candidates![0].bookings, TODAY), true);
});

Deno.test("a failed bookings page makes the candidate read fail", async () => {
  const filler = Array.from({ length: 600 }, (_, i) => ({
    id: `a${String(i).padStart(5, "0")}`,
    job_id: "busy",
    ...work(TODAY),
  }));
  const client = cappedClient({
    jobs: [{
      id: "busy",
      job_number: "SWF-busy",
      type: "fencing",
      status: "scheduled",
      metadata: {},
    }],
    makesafe_job_details: [],
    job_assignments: filler,
  }, { table: "job_assignments", from: 500 });
  assertEquals(await loadJobAutoStartCandidates(client), null);
});

Deno.test("helpers: work bookings, booked today, lanes", () => {
  assertEquals(isWorkBooking(work(TODAY, { assignment_type: null })), true);
  assertEquals(
    isWorkBooking(work(TODAY, { assignment_type: "delivery" })),
    false,
  );
  assertEquals(isWorkBooking(work(TODAY, { status: null })), true);
  assertEquals(hasWorkBookingOn([work(TOMORROW), work(TODAY)], TODAY), true);
  assertEquals(hasWorkBookingOn([work(TOMORROW)], TODAY), false);
  assertEquals(hasWorkBookingOn([], TODAY), false);
  assertEquals(autoStartLane({ type: "fencing", status: "scheduled" }), {
    lane: "status",
  });
  assertEquals(
    autoStartLane(
      { type: "makesafe", status: "scheduled", metadata: {} },
      { report_type: "repair" },
    ),
    { lane: "repair", move_status: true },
  );
});

Deno.test("the door: server key only, POST only", async () => {
  const h = harness([job("1", [work(TODAY)])]);
  assertEquals(
    (await runJobAutoStartAction("POST", LIVE, false, h.deps)).status,
    403,
  );
  assertEquals(
    (await runJobAutoStartAction("GET", LIVE, true, h.deps)).status,
    405,
  );
  const ok = await runJobAutoStartAction("POST", LIVE, true, h.deps);
  assertEquals(ok.status, 200);
  assertEquals(h.statusMoves.length, 1);
});
