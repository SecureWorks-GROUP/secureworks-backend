// deno-lint-ignore-file no-explicit-any
/**
 * Is this GoHighLevel contact a live party on this job's contact list?
 *
 * The two text guards (ops-api sendChaseSms's assertGhlContactMatchesResolvedJob and
 * ghl-proxy send_sms's contact/job match) accept a contact that is EITHER the job's own
 * contact (jobs.ghl_contact_id) OR the ghl_contact_id of a live job_contacts row on the
 * SAME job: a neighbour on a shared fence (Captain ruling, 12 Oct 2026: "allow texting a
 * neighbour who is on the same job's contact list"). This file is the job_contacts half
 * of that check, shared so both guards read the list the same way.
 *
 * A row is live while its status is empty or 'active' and it has no removed_at. A
 * removed party (status 'removed', soft-deleted with removed_at) is never accepted.
 * A contact on another job's list, or on no list, is never accepted.
 *
 * Every condition is checked again on the rows that come back, so a looser query (or a
 * test fake that ignores filters) can never widen the answer.
 */

export interface JobContactMembershipRow {
  id?: string | null;
  job_id?: string | null;
  ghl_contact_id?: string | null;
  status?: string | null;
  removed_at?: string | null;
}

export type JobContactMembership =
  | { ok: true; job_contact_id: string | null }
  | { ok: false; reason: "not_on_job" }
  | { ok: false; reason: "lookup_failed"; message: string };

const clean = (
  v: unknown,
) => (v === null || v === undefined ? "" : String(v).trim());

/** True when this job_contacts row is a live party on jobId carrying ghlContactId. */
export function isLiveJobContactFor(
  row: JobContactMembershipRow | null | undefined,
  jobId: string,
  ghlContactId: string,
): boolean {
  if (!row) return false;
  const want = clean(ghlContactId);
  if (!want || !clean(jobId)) return false;
  if (clean(row.job_id) !== clean(jobId)) return false;
  if (clean(row.ghl_contact_id) !== want) return false;
  const status = clean(row.status).toLowerCase();
  if (status && status !== "active") return false;
  if (clean(row.removed_at)) return false;
  return true;
}

/**
 * Looks for a live job_contacts row on jobId whose ghl_contact_id is ghlContactId.
 * lookup_failed when the read errors or throws: callers fail closed on it (the contact
 * is not proven to be on the job).
 */
export async function findLiveJobContactForGhlContact(
  client: any,
  jobId: string,
  ghlContactId: string,
): Promise<JobContactMembership> {
  const want = clean(ghlContactId);
  const job = clean(jobId);
  if (!want || !job) return { ok: false, reason: "not_on_job" };
  try {
    const { data, error } = await client.from("job_contacts")
      .select("id,job_id,ghl_contact_id,status,removed_at")
      .eq("job_id", job)
      .eq("ghl_contact_id", want)
      .or("status.is.null,status.eq.active")
      .is("removed_at", null)
      .limit(5);
    if (error) {
      return {
        ok: false,
        reason: "lookup_failed",
        message: clean(error.message) || "job_contacts read failed",
      };
    }
    const rows: JobContactMembershipRow[] = Array.isArray(data) ? data : [];
    const live = rows.find((r) => isLiveJobContactFor(r, job, want));
    return live
      ? { ok: true, job_contact_id: clean(live.id) || null }
      : { ok: false, reason: "not_on_job" };
  } catch (e) {
    return {
      ok: false,
      reason: "lookup_failed",
      message: clean((e as Error)?.message) || "job_contacts read failed",
    };
  }
}
