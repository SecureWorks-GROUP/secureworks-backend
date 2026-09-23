// deno-lint-ignore-file no-explicit-any
//
// Job freshness read (context build slice K4; cadence design sections 4 and
// 9.D).
//
// How current the job's extracted facts are, answered at question time: when
// the facts were last read, how many newer items are waiting, when the next
// read is due or why it is held, and how many of this customer's messages sit
// unplaced (on no job, on a holding job, or waiting between this job and
// another). One call to the read-only SQL function public.context_job_freshness
// (migration 20260924030000, slice K1), nothing else: no table read, no
// provider call, no model call, no write.
//
// One interpreter per fact:
//   - every number, time and the blocked reason come from
//     context_job_freshness, which takes them from context_job_cadence (the
//     same judgement the worker's claim and the heartbeat use) and from
//     context_unplaced_for_job (the same count the last-contact read uses);
//   - the rendered line is the SQL function's own line. This module never
//     re-renders or re-derives any of it, so the job read and the worker can
//     never disagree about when a job is next read.
//
// A failed read is unknown with a reason, never "fresh": the section is null
// and sourceStatus.freshness carries state failed and a code. A NULL answer
// (the function found no job) is the same, code empty_payload. An answer whose
// shape this module does not recognise is refused (invalid_shape), not guessed.

export const JOB_FRESHNESS_READ_VERSION = "job-freshness/v1";

/** Dossier sourceStatus entry for the freshness section (dossier Review 19 shape). */
export interface FreshnessSourceStatus {
  ok: boolean;
  state: "ok" | "failed";
  /** Newer items not yet read (unread_count); 0 when the read failed. */
  count: number;
  code?: string;
}

/** The dossier's `freshness` section: context_job_freshness, minus any job_id. */
export interface JobFreshness {
  /** When the job's facts were last read (a finished extraction run), or null. */
  last_run_finished_at: string | null;
  /** Linked, worded, stamped rows on the job with no read receipt yet. */
  unread_count: number;
  oldest_unread_landed_at: string | null;
  /** When the next read is due; null when nothing will wake the job. */
  next_due_at: string | null;
  runs_today: number;
  /**
   * Why a read is held: lane_off, holding_job, daily_ceiling, retry_wait,
   * model_cap, pacing_reserve (as the SQL judgement names it), or null.
   */
  blocked_reason: string | null;
  /** This customer's messages not yet placed on any job (context_unplaced_for_job). */
  unplaced_for_contact: { count: number; newest_at: string | null };
  /** The job has no GHL contact, so a customer's unplaced texts cannot be counted by contact. */
  contact_missing: boolean;
  /** "Facts current to ...; N newer items not yet read, next read due ...; M messages ..." */
  line: string;
}

function isTime(v: unknown): v is string | null {
  return v === null || (typeof v === "string" && !isNaN(Date.parse(v)));
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/**
 * Validates one context_job_freshness answer for the requested job. Returns
 * the section, or null when the shape is not the one the SQL function
 * publishes, or the answer names a different job (the caller reports
 * invalid_shape).
 */
export function freshnessFromRpc(
  data: unknown,
  jobId: string,
): JobFreshness | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, any>;
  const unplaced = d.unplaced_for_contact;
  if (
    // job_id is carried by the K1 body; an answer naming another job is
    // refused, an answer without the key is the one the RPC was asked for.
    (d.job_id !== undefined && d.job_id !== jobId) ||
    !isTime(d.last_run_finished_at) ||
    !isCount(d.unread_count) ||
    !isTime(d.oldest_unread_landed_at) ||
    !isTime(d.next_due_at) ||
    !isCount(d.runs_today) ||
    !(d.blocked_reason === null || typeof d.blocked_reason === "string") ||
    !unplaced || typeof unplaced !== "object" ||
    !isCount(unplaced.count) || !isTime(unplaced.newest_at) ||
    typeof d.contact_missing !== "boolean" ||
    typeof d.line !== "string" || d.line === ""
  ) {
    return null;
  }
  return {
    last_run_finished_at: d.last_run_finished_at,
    unread_count: d.unread_count,
    oldest_unread_landed_at: d.oldest_unread_landed_at,
    next_due_at: d.next_due_at,
    runs_today: d.runs_today,
    blocked_reason: d.blocked_reason,
    unplaced_for_contact: {
      count: unplaced.count,
      newest_at: unplaced.newest_at,
    },
    contact_missing: d.contact_missing,
    line: d.line,
  };
}

function rpcCode(error: any): string {
  const code = typeof error?.code === "string" ? error.code.trim() : "";
  return /^[A-Za-z0-9_]{1,32}$/.test(code) ? code : "read_failed";
}

/** Reads the job's freshness section plus its source status. Never throws. */
export async function readJobFreshness(
  client: any,
  jobId: string,
): Promise<{ freshness: JobFreshness | null; status: FreshnessSourceStatus }> {
  const failed = (code: string) => ({
    freshness: null,
    status: { ok: false, state: "failed" as const, count: 0, code },
  });
  let data: unknown;
  try {
    const res = await client.rpc("context_job_freshness", { p_job_id: jobId });
    if (res?.error) return failed(rpcCode(res.error));
    data = res?.data;
  } catch (_e) {
    return failed("read_threw");
  }
  if (data === null || data === undefined) return failed("empty_payload");
  const freshness = freshnessFromRpc(data, jobId);
  if (!freshness) return failed("invalid_shape");
  return {
    freshness,
    status: { ok: true, state: "ok", count: freshness.unread_count },
  };
}
