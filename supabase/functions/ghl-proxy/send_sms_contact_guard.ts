// deno-lint-ignore-file no-explicit-any
/**
 * send_sms's contact/job match, out of the handler so it can be tested.
 *
 * When a caller names both contactId and jobId, the text goes ahead only when the contact
 * is the job's own contact (jobs.ghl_contact_id) or a live party on the SAME job's
 * contact list (a neighbour on a shared fence; Captain ruling 12 Oct 2026). Anything else
 * is the 409 "Contact mismatch" it always was.
 *
 * Unchanged from before: the job read is best-effort (a failed or empty read, or a job
 * with no contact of its own, lets the send through, as it always has). New and fail
 * closed: once the contact is not the job's own, a failed contact-list read refuses,
 * because the neighbour is then not proven to be on the job.
 *
 * namedJob is the row read here; the evidence row's job custody (sms_capture.ts
 * sendSmsJobCustody) still verifies only the job's own contact.
 */
import { findLiveJobContactForGhlContact } from "../_shared/job_contact_membership.ts";

export interface SendSmsNamedJob {
  ghl_contact_id?: string | null;
  client_name?: string | null;
}

export interface SendSmsContactGuardResult {
  namedJob: SendSmsNamedJob | null;
  /** null: send. Otherwise the 409 body to return; nothing is sent. */
  refusal: Record<string, unknown> | null;
  /** How the contact passed, for the log. */
  via: "no_job" | "job_unread" | "job_contact" | "job_party" | null;
}

export async function checkSendSmsContactJob(
  sb: any,
  jobId: string | null | undefined,
  contactId: string | null | undefined,
): Promise<SendSmsContactGuardResult> {
  if (!contactId || !jobId) {
    return { namedJob: null, refusal: null, via: "no_job" };
  }
  let job: SendSmsNamedJob | null = null;
  try {
    const { data } = await sb.from("jobs")
      .select("ghl_contact_id, client_name")
      .eq("id", jobId)
      .single();
    job = data || null;
  } catch {
    // Non-blocking, as before: if the job lookup fails, allow the send.
    return { namedJob: null, refusal: null, via: "job_unread" };
  }
  if (!job || !job.ghl_contact_id) {
    return { namedJob: job, refusal: null, via: "job_unread" };
  }
  if (job.ghl_contact_id === contactId) {
    return { namedJob: job, refusal: null, via: "job_contact" };
  }
  const party = await findLiveJobContactForGhlContact(sb, jobId, contactId);
  if (party.ok) return { namedJob: job, refusal: null, via: "job_party" };
  return {
    namedJob: job,
    via: null,
    refusal: {
      error: party.reason === "lookup_failed"
        ? "Contact mismatch: contactId is not the job contact and the job's contact list could not be read. SMS blocked."
        : "Contact mismatch: contactId does not match the job contact. SMS blocked.",
      expected_contact: job.ghl_contact_id,
      expected_name: job.client_name ?? null,
      supplied_contact: contactId,
    },
  };
}
