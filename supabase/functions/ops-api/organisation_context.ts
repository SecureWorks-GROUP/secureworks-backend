export const ORGANISATION_CONTEXT_VERSION = "organisation-context/v1";

export class OrganisationContextError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function organisationContext(
  client: { from: (t: string) => any; rpc?: Function },
  body: { org_id: string; mode?: string; facts_limit?: number },
) {
  const orgId = (body.org_id || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgId)) {
    throw new OrganisationContextError(400, "org_id must be a UUID");
  }
  const limit = Math.min(Math.max(body.facts_limit ?? 40, 1), 100);
  const { data: org, error: orgErr } = await client.from("organisations").select("id,name").eq("id", orgId).maybeSingle();
  if (orgErr) return { version: ORGANISATION_CONTEXT_VERSION, org_id: orgId, sources: { organisations: { ok: false, error: orgErr.message } }, facts: [], blockers: ["organisations_unreadable"] };
  if (!org) throw new OrganisationContextError(404, "organisation not found");
  const { data: facts, error: factErr } = await client.from("current_organisation_context_facts")
    .select("id,org_id,kind,value,provenance,updated_at,subject_refs,validity_basis,trust")
    .eq("org_id", orgId).order("updated_at", { ascending: false }).limit(limit);
  return {
    version: ORGANISATION_CONTEXT_VERSION,
    org_id: orgId,
    org,
    facts: facts || [],
    sources: { facts: { ok: !factErr, error: factErr?.message } },
    applicability: "companywide",
    blockers: factErr ? ["facts_unreadable"] : [],
  };
}
