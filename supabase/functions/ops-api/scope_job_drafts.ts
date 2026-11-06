// Local drafts only. The transaction reads the frozen source itself; this
// boundary never accepts money, an organisation, or an acceptance claim.
export type ScopeDraftActor = { staff: boolean; orgId: string | null };

export async function scopeJobDraftsAction(
  // deno-lint-ignore no-explicit-any
  client: any,
  action: string,
  method: string,
  body: unknown,
  actor: ScopeDraftActor,
): Promise<Response> {
  const reply = (payload: unknown, status = 200) =>
    Response.json(payload, { status });
  if (method !== "POST") return reply({ code: "method_not_allowed" }, 405);
  if (!actor.staff || !actor.orgId) {
    return reply({ code: "operator_access_required" }, 403);
  }
  const input = body as Record<string, unknown> | null;
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    !input || Array.isArray(input) ||
    Object.keys(input).some((k) =>
      !["job_id", "scope_revision_id"].includes(k)
    ) ||
    !uuid.test(String(input.job_id ?? "")) ||
    !uuid.test(String(input.scope_revision_id ?? ""))
  ) {
    return reply({
      code: "scope_draft_input_invalid",
      error: "Only job_id and scope_revision_id are accepted.",
    }, 400);
  }
  const { data, error } = await client.rpc(action, {
    p_job_id: input.job_id,
    p_scope_revision_id: input.scope_revision_id,
    p_org_id: actor.orgId,
  });
  if (error) {
    const code = String(error.message ?? "");
    const known = /^scope_drafts_[a-z_]+$/.test(code);
    return reply(
      { code: known ? code : "scope_drafts_unavailable" },
      !known
        ? 503
        : code.endsWith("not_found")
        ? 404
        : code.endsWith("forbidden")
        ? 403
        : 409,
    );
  }
  if (!data) return reply({ code: "scope_drafts_unavailable" }, 503);
  return reply(data);
}
