// Slice S-M1 (sites.md section 2 "The split-site path"): the ops-api door onto
// link_site_jobs, the one writer of job_site_links.
//
//   POST ?action=link_site_jobs
//     { job_id, site_lead_job_id, link_kind, decision, evidence? }
//     -> RPC link_site_jobs(p_job_id, p_site_lead_job_id, p_link_kind,
//        p_decision, p_actor, p_evidence)
//
// A person proposes, confirms or rejects that two legacy job records are one
// site (split_party, option, stage or repeat). Nothing is merged, moved or
// deleted; the database writes one job_party_events receipt with the actor.
// Staff front door only (no routine or agent-read key reaches it). The actor
// is F-ACT's (verified JWT user, trusted server-key header, or actor_missing):
// recorded, never an access gate.

export class SiteLinkError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const SITE_LINK_KINDS = [
  "split_party",
  "option",
  "stage",
  "repeat",
] as const;
export const SITE_LINK_DECISIONS = ["propose", "confirm", "reject"] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Refusals raised by the SQL writer and the HTTP status each maps to.
const REFUSALS: Record<string, number> = {
  site_link_jobs_required: 400,
  site_link_self: 400,
  site_link_kind_invalid: 400,
  site_link_decision_invalid: 400,
  site_link_actor_required: 400,
  site_link_evidence_invalid: 400,
  site_link_job_not_found: 404,
  site_lead_is_linked: 409,
  job_is_site_lead: 409,
  site_link_already_confirmed: 409,
  site_link_other_lead: 409,
};

type Rpc = {
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

function bad(message: string): never {
  throw new SiteLinkError("invalid_request", 400, message);
}

export function siteLinkArgs(
  body: unknown,
  actor: string,
): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    bad("body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  const allowed = new Set([
    "job_id",
    "site_lead_job_id",
    "link_kind",
    "decision",
    "evidence",
  ]);
  for (const key of Object.keys(b)) {
    if (!allowed.has(key)) bad(`unknown field ${key}`);
  }
  const jobId = String(b.job_id ?? "");
  const leadId = String(b.site_lead_job_id ?? "");
  if (!UUID.test(jobId)) bad("job_id must be a uuid");
  if (!UUID.test(leadId)) bad("site_lead_job_id must be a uuid");
  if (jobId.toLowerCase() === leadId.toLowerCase()) {
    throw new SiteLinkError(
      "site_link_self",
      400,
      "a job cannot be its own site lead",
    );
  }
  const kind = String(b.link_kind ?? "");
  if (!(SITE_LINK_KINDS as readonly string[]).includes(kind)) {
    bad(`link_kind must be one of ${SITE_LINK_KINDS.join(", ")}`);
  }
  const decision = String(b.decision ?? "");
  if (!(SITE_LINK_DECISIONS as readonly string[]).includes(decision)) {
    bad(`decision must be one of ${SITE_LINK_DECISIONS.join(", ")}`);
  }
  let evidence: Record<string, unknown> = {};
  if (b.evidence !== undefined && b.evidence !== null) {
    if (typeof b.evidence !== "object" || Array.isArray(b.evidence)) {
      bad("evidence must be a JSON object");
    }
    evidence = b.evidence as Record<string, unknown>;
    if (new TextEncoder().encode(JSON.stringify(evidence)).length > 4096) {
      bad("evidence must be at most 4096 bytes");
    }
  }
  return {
    p_job_id: jobId,
    p_site_lead_job_id: leadId,
    p_link_kind: kind,
    p_decision: decision,
    p_actor: actor.slice(0, 200),
    p_evidence: evidence,
  };
}

export async function linkSiteJobs(
  client: Rpc,
  body: unknown,
  actor: string,
): Promise<Record<string, unknown>> {
  const args = siteLinkArgs(body, actor);
  const { data, error } = await client.rpc("link_site_jobs", args);
  if (error) {
    const message = String((error as { message?: unknown }).message ?? "");
    const status = REFUSALS[message];
    if (status) throw new SiteLinkError(message, status, message);
    throw new SiteLinkError(
      "site_link_failed",
      503,
      "the site link could not be written",
    );
  }
  if (!data || typeof data !== "object") {
    throw new SiteLinkError(
      "site_link_failed",
      503,
      "the site link returned nothing",
    );
  }
  return data as Record<string, unknown>;
}
