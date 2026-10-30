// deno-lint-ignore-file no-import-prefix require-await
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type AbandonedSweep,
  abandonStuckOutlookSweeps,
  outlookSweepIsStuck,
  SWEEP_NO_PROGRESS_MS,
  type SweepRun,
} from "./sweep_janitor.ts";

const NOW = Date.parse("2026-10-02T06:00:00Z");

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function run(partial: Partial<SweepRun> & Pick<SweepRun, "id">): SweepRun {
  return {
    source: "outlook_sweep_nithin",
    status: "running",
    updated_at: iso(NOW - SWEEP_NO_PROGRESS_MS - 1),
    ...partial,
  };
}

Deno.test("a sweep is stuck only when it is still running with no write for about two hours", () => {
  assertEquals(
    outlookSweepIsStuck(
      run({ id: "fresh", updated_at: iso(NOW - SWEEP_NO_PROGRESS_MS + 1) }),
      NOW,
    ),
    false,
  );
  assertEquals(
    outlookSweepIsStuck(
      run({ id: "exact", updated_at: iso(NOW - SWEEP_NO_PROGRESS_MS) }),
      NOW,
    ),
    true,
  );
  assertEquals(
    outlookSweepIsStuck(
      run({ id: "old", updated_at: iso(NOW - 3 * 60 * 60 * 1000) }),
      NOW,
    ),
    true,
  );
  // A later write is progress, even when the run started long before.
  assertEquals(
    outlookSweepIsStuck(
      run({ id: "wrote", updated_at: iso(NOW - 10 * 60 * 1000) }),
      NOW,
    ),
    false,
  );
  assertEquals(
    outlookSweepIsStuck(
      run({ id: "blank", updated_at: "not-a-time" }),
      NOW,
    ),
    true,
  );
  assertEquals(
    outlookSweepIsStuck(
      run({
        id: "done",
        status: "failed",
        updated_at: iso(NOW - 5 * 60 * 60 * 1000),
      }),
      NOW,
    ),
    false,
  );
  assertEquals(
    outlookSweepIsStuck(
      run({
        id: "poll",
        source: "outlook_nithin",
        updated_at: iso(NOW - 5 * 60 * 60 * 1000),
      }),
      NOW,
    ),
    false,
  );
  assertEquals(
    outlookSweepIsStuck(
      run({
        id: "history",
        source: "outlook_history_nithin",
        updated_at: iso(NOW - 5 * 60 * 60 * 1000),
      }),
      NOW,
    ),
    false,
  );
});

Deno.test("the janitor closes only stuck sweeps, and a second pass writes nothing", async () => {
  const runs = [
    run({ id: "stuck", updated_at: iso(NOW - 3 * 60 * 60 * 1000) }),
    run({ id: "live", updated_at: iso(NOW - 30 * 60 * 1000) }),
    run({
      id: "poll",
      source: "outlook_nithin",
      updated_at: iso(NOW - 5 * 60 * 60 * 1000),
    }),
    run({
      id: "finished",
      status: "succeeded",
      updated_at: iso(NOW - 5 * 60 * 60 * 1000),
    }),
  ];
  const writes: AbandonedSweep[] = [];
  const closed = await abandonStuckOutlookSweeps(runs, NOW, async (row) => {
    writes.push(row);
  });
  assertEquals(closed, ["stuck"]);
  assertEquals(writes, [{
    run_id: "stuck",
    source: "outlook_sweep_nithin",
    status: "failed",
    error_code: "abandoned",
  }]);
  assertEquals(runs[0].status, "failed");
  assertEquals(runs[1].status, "running");
  assertEquals(runs[2].status, "running");
  assertEquals(runs[3].status, "succeeded");

  const again = await abandonStuckOutlookSweeps(runs, NOW, async (row) => {
    writes.push(row);
  });
  assertEquals(again, []);
  assertEquals(writes.length, 1);
});

Deno.test("a sweep already finished is closed without a second write", async () => {
  const runs = [run({ id: "raced" })];
  const writes: string[] = [];
  const closed = await abandonStuckOutlookSweeps(runs, NOW, async () => {
    writes.push("write");
    throw Object.assign(new Error("capture_run_finished"), {
      code: "capture_run_finished",
    });
  });
  assertEquals(writes, ["write"]);
  assertEquals(closed, ["raced"]);
  assertEquals(runs[0].status, "failed");
  const again = await abandonStuckOutlookSweeps(runs, NOW, async () => {
    writes.push("again");
  });
  assertEquals(again, []);
  assertEquals(writes, ["write"]);
});

Deno.test("any other write failure is not treated as already closed", async () => {
  const runs = [run({ id: "down" })];
  await assertRejects(
    () =>
      abandonStuckOutlookSweeps(runs, NOW, async () => {
        throw Object.assign(new Error("record_capture_run_failed"), {
          code: "record_capture_run_failed",
        });
      }),
    Error,
    "record_capture_run_failed",
  );
  assertEquals(runs[0].status, "running");
});
