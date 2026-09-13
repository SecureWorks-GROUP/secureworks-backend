// Executable scoped refresh: same RPC for UI, terminal and cloud.
export class WorkflowRefreshError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function startWorkflowRefresh(
  client: { rpc: Function },
  body: { workflow?: string; scope?: Record<string, unknown>; actor?: string },
) {
  const workflow = String(body.workflow || "").trim();
  const actor = String(body.actor || "ops").trim();
  const scope = body.scope && typeof body.scope === "object" ? body.scope : {};
  if (!workflow) throw new WorkflowRefreshError(400, "workflow is required");
  const { data, error } = await client.rpc("start_workflow_refresh", {
    p_workflow: workflow,
    p_scope: scope,
    p_actor: actor,
  });
  if (error) throw new WorkflowRefreshError(500, error.message);
  return data;
}

export async function finishWorkflowRefresh(
  client: { rpc: Function },
  body: { id: string; status: string; result?: unknown; source_cutoff?: string },
) {
  const { data, error } = await client.rpc("finish_workflow_refresh", {
    p_id: body.id,
    p_status: body.status,
    p_result: body.result ?? {},
    p_cutoff: body.source_cutoff ?? null,
  });
  if (error) throw new WorkflowRefreshError(500, error.message);
  return data;
}
