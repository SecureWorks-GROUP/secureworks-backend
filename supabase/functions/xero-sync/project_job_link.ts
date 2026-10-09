// Which job a Xero Project belongs to (job profitability PR 1).
//
// The bookkeeper names most projects after the job ("SWF-26764 14 Curlew Ct
// Ballajura"). A job number in the name that resolves to exactly one job is
// the project's job. Otherwise the older contact path stands: the project's
// Xero contact, through contact_matches. The name wins when the two disagree,
// because one contact can own several jobs (repeat clients, a neighbour's
// job) and the contact map keeps only one of them.
//
// Only xero_projects.job_id is decided here; nothing else is written.

import { extractJobNumber } from "./materials_ingest.ts";

export type ProjectJobLinkMethod = "project_name_job_number" | "contact_match" | null;

/** The job number a project name carries, in the shared job-reference grammar. */
export function projectNameJobNumber(name: string | null | undefined): string | null {
  return extractJobNumber(name);
}

/**
 * Resolve a project's job. `jobIdsByNumber` maps a job number to every job id
 * carrying it (so an ambiguous number is visible as more than one id).
 */
export function resolveProjectJobId(input: {
  name: string | null | undefined;
  contactId: string | null | undefined;
  jobIdsByNumber: Map<string, string[]>;
  contactToJob: Map<string, string>;
}): { jobId: string | null; method: ProjectJobLinkMethod } {
  const token = projectNameJobNumber(input.name);
  if (token) {
    const ids = input.jobIdsByNumber.get(token) ?? [];
    if (ids.length === 1) return { jobId: ids[0], method: "project_name_job_number" };
  }
  const contactJob = input.contactId ? input.contactToJob.get(input.contactId) : undefined;
  if (contactJob) return { jobId: contactJob, method: "contact_match" };
  return { jobId: null, method: null };
}
