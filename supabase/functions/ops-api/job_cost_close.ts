// deno-lint-ignore-file no-explicit-any
// Job cost close: is a job's cost final, and if not, what it is waiting on.
//
// Reads public.job_cost_close (20261115143000_job_cost_close.sql), which works
// the state out from Job Profit's own row on every read. Nothing is worked out
// here and nothing is written. The read rides beside the Job Profit figures
// and never fails them: a read that fails, or a job the engine has no row
// for, answers { ok: false, reason }, never "final" and never "open".

export const JOB_COST_CLOSE_RPC = "job_cost_close";

export const JOB_COST_CLOSE_STATES = [
  "not_applicable",
  "open",
  "waiting",
  "settling",
  "final",
] as const;

const FIELDS = [
  "cost_state",
  "cost_final",
  "final_on",
  "closed_by",
  "finished",
  "finished_on",
  "finished_basis",
  "last_cost_on",
  "waiting_on",
  "all_costs_paid",
  "quiet_days",
  "as_of",
  "rule",
] as const;

export type JobCostClose =
  | ({ ok: true } & Record<(typeof FIELDS)[number], unknown>)
  | { ok: false; reason: string };

/** One engine row as the response carries it, or null when it is not one. */
export function costCloseFromRow(row: unknown): JobCostClose | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const r = row as Record<string, unknown>;
  if (
    typeof r.cost_state !== "string" ||
    !(JOB_COST_CLOSE_STATES as readonly string[]).includes(r.cost_state)
  ) {
    return null;
  }
  const out: Record<string, unknown> = { ok: true };
  for (const k of FIELDS) out[k] = r[k] ?? null;
  // The engine says final only with the day and the rule; anything else is
  // not a close this response will repeat.
  if (
    (r.cost_state === "final") !== (r.cost_final === true) ||
    (r.cost_state === "final" && (!r.final_on || !r.closed_by))
  ) {
    return null;
  }
  out.waiting_on = Array.isArray(r.waiting_on) ? r.waiting_on.map(String) : [];
  return out as JobCostClose;
}

async function readRows(
  client: any,
  jobIds: string[],
): Promise<{ rows: any[] } | { reason: string }> {
  if (typeof client?.rpc !== "function") {
    return { reason: "cost close is not readable here" };
  }
  try {
    const { data, error } = await client.rpc(JOB_COST_CLOSE_RPC, {
      p_job_ids: jobIds,
    });
    if (error) return { reason: `cost close read failed: ${error.message}` };
    if (!Array.isArray(data)) {
      return { reason: "cost close read returned nothing" };
    }
    return { rows: data };
  } catch (e) {
    return { reason: `cost close read failed: ${(e as Error).message}` };
  }
}

/** One job's cost close for ops-api `job_profit`. */
export async function readJobCostClose(
  client: any,
  jobId: string,
): Promise<JobCostClose> {
  const read = await readRows(client, [jobId]);
  if ("reason" in read) return { ok: false, reason: read.reason };
  const row = read.rows.find((r) => r && r.job_id === jobId);
  if (!row) return { ok: false, reason: "the engine has no cost close row for this job" };
  return costCloseFromRow(row) ??
    { ok: false, reason: "cost close row was not in the shape the engine publishes" };
}

/**
 * A page of jobs for ops-api `job_profit_list`: by_job holds each job the
 * engine answered. A job missing from by_job is not known, never open.
 */
export async function readJobCostCloseMany(
  client: any,
  jobIds: string[],
): Promise<
  | { ok: true; by_job: Record<string, JobCostClose> }
  | { ok: false; reason: string }
> {
  const ids = [...new Set(jobIds.filter((id) => typeof id === "string" && id))];
  if (!ids.length) return { ok: true, by_job: {} };
  const read = await readRows(client, ids);
  if ("reason" in read) return { ok: false, reason: read.reason };
  const by_job: Record<string, JobCostClose> = {};
  for (const row of read.rows) {
    const id = row && typeof row.job_id === "string" ? row.job_id : null;
    if (!id || !ids.includes(id)) continue;
    const close = costCloseFromRow(row);
    if (close) by_job[id] = close;
  }
  return { ok: true, by_job };
}
