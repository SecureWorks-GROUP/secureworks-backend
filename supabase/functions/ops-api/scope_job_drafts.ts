// Local drafts only. The transaction reads the frozen source itself; this
// boundary never accepts money, an organisation, or an acceptance claim.
// The read also carries both owner approval decisions for this revision, the
// work order's actual state and what the caller may approve (worked out on
// the server from owner_approval_authority, never from the client).
import type { WorkOrderApprover } from "./job_work_orders.ts";
import { ownerApprovalCapabilities } from "./scope_owner_approvals.ts";

export type ScopeDraftActor = {
  staff: boolean;
  orgId: string | null;
  approver?: WorkOrderApprover | null;
};

// A freeze is durable before this handoff runs. Return a distinct outcome so
// clients retain the saved revision while showing any unsaved work-order hold.
export async function prepareScopeDraftsAfterFreeze(
  // deno-lint-ignore no-explicit-any
  client: any,
  input: { job_id: string; scope_revision_id: string },
  actor: ScopeDraftActor,
): Promise<{ status: number; data: unknown }> {
  try {
    const response = await scopeJobDraftsAction(
      client,
      "prepare_scope_job_drafts",
      "POST",
      input,
      actor,
    );
    return { status: response.status, data: await response.json() };
  } catch {
    return { status: 503, data: { code: "scope_drafts_unavailable" } };
  }
}

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
  if (action === "read_scope_job_drafts" && typeof data === "object") {
    return reply({
      ...data,
      capabilities: await ownerApprovalCapabilities(
        client,
        actor.approver ?? null,
      ),
    });
  }
  return reply(data);
}
