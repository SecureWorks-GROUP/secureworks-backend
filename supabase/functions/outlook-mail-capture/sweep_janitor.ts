// Closes outlook sweep runs the worker left running, so the next sweep of
// that source can start. A running outlook_sweep_* row is the lock
// (runSource returns busy while one is still running).
//
// Progress is the row's updated_at: a sweep does not rewrite its row while
// it works, so a worker that stopped leaves that time at the start. About
// two hours with no write is abandoned. The table has no status
// "abandoned"; record_capture_run closes it failed with error_code
// abandoned, the same mark a poll uses after ten minutes.
//
// Idempotent. A finished row is not selected, and a second pass over the
// same objects (status already failed) writes nothing. A row another caller
// already finished (capture_run_finished) is treated as closed.

export const SWEEP_SOURCE_PREFIX = "outlook_sweep_";

/** About two hours. A sweep with no write for this long is abandoned. */
export const SWEEP_NO_PROGRESS_MS = 2 * 60 * 60 * 1000;

export interface SweepRun {
  id: string;
  source: string;
  status: string;
  updated_at: string;
}

export interface AbandonedSweep {
  run_id: string;
  source: string;
  status: "failed";
  error_code: "abandoned";
}

function updatedMs(value: string): number | null {
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/**
 * A running outlook sweep whose last write is missing or at least
 * SWEEP_NO_PROGRESS_MS ago. Anything else, including a poll or history row
 * and a sweep that has been written inside the window, is left alone.
 */
export function outlookSweepIsStuck(
  run: SweepRun,
  nowMs: number,
  staleMs: number = SWEEP_NO_PROGRESS_MS,
): boolean {
  if (run.status !== "running") return false;
  if (!run.source.startsWith(SWEEP_SOURCE_PREFIX)) return false;
  const updated = updatedMs(run.updated_at);
  if (updated === null) return true;
  return nowMs - updated >= staleMs;
}

/**
 * Close every stuck sweep in `runs`. Returns the run ids it closed.
 * Mutates those rows to status failed so a second call on the same array
 * writes nothing. `record` is record_capture_run; capture_run_finished
 * means the row was already closed and is not an error.
 */
export async function abandonStuckOutlookSweeps(
  runs: SweepRun[],
  nowMs: number,
  record: (row: AbandonedSweep) => Promise<unknown>,
  staleMs: number = SWEEP_NO_PROGRESS_MS,
): Promise<string[]> {
  const closed: string[] = [];
  for (const run of runs) {
    if (!outlookSweepIsStuck(run, nowMs, staleMs)) continue;
    try {
      await record({
        run_id: run.id,
        source: run.source,
        status: "failed",
        error_code: "abandoned",
      });
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      if (code !== "capture_run_finished") throw e;
    }
    run.status = "failed";
    closed.push(run.id);
  }
  return closed;
}
