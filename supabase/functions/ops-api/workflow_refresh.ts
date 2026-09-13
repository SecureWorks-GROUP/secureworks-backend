// Executable scoped refresh: same RPC for UI, terminal and cloud.
// Start coalesces. Dispatch clicks are consumed by consume_dispatch_refresh
// with lease, source readback and terminal status. Finish requires the
// stored lease token and owner.

export const WORKFLOW_REFRESH_OWNERS = [
  "dispatch",
  "debt",
  "ses",
  "booking",
  "performance",
] as const;

export const WORKFLOW_REFRESH_SCOPE_KEYS = ["job_id", "org_id", "week_start"] as const;

export class WorkflowRefreshError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function assertWorkflowRefreshBoundary(body: {
  workflow?: string;
  scope?: Record<string, unknown>;
  owner?: string;
}) {
  const workflow = String(body.workflow || body.owner || "").trim();
  if (!WORKFLOW_REFRESH_OWNERS.includes(workflow as typeof WORKFLOW_REFRESH_OWNERS[number])) {
    throw new WorkflowRefreshError(400, "workflow is not allowlisted");
  }
  const scope = body.scope && typeof body.scope === "object" ? body.scope : {};
  for (const key of Object.keys(scope)) {
    if (!WORKFLOW_REFRESH_SCOPE_KEYS.includes(key as typeof WORKFLOW_REFRESH_SCOPE_KEYS[number])) {
      throw new WorkflowRefreshError(400, "refresh scope is not allowlisted");
    }
  }
  return { workflow, scope };
}

export function refreshActorFromAuth(
  authMode: string,
  authUser: { id?: string; orgId?: string } | null,
  bodyActor: unknown,
  expectedOrgId: string,
) {
  if (authMode === "jwt") {
    if (!authUser?.id) throw new WorkflowRefreshError(401, "named operator required");
    if (authUser.orgId && authUser.orgId !== expectedOrgId) {
      throw new WorkflowRefreshError(403, "operator organisation mismatch");
    }
    return authUser.id;
  }
  const actor = String(bodyActor || "ops-api").trim();
  if (!actor) throw new WorkflowRefreshError(400, "actor is required");
  return actor;
}

export async function startWorkflowRefresh(
  client: { rpc: Function },
  body: { workflow?: string; scope?: Record<string, unknown>; actor?: string },
) {
  const { workflow, scope } = assertWorkflowRefreshBoundary(body);
  const actor = String(body.actor || "").trim();
  if (!actor) throw new WorkflowRefreshError(400, "actor is required");
  const { data, error } = await client.rpc("start_workflow_refresh", {
    p_workflow: workflow,
    p_scope: scope,
    p_actor: actor,
  });
  if (error) throw new WorkflowRefreshError(500, error.message);
  return data;
}

export async function consumeDispatchRefresh(
  client: { rpc: Function },
  body: { id: string },
) {
  const { data, error } = await client.rpc("consume_dispatch_refresh", { p_id: body.id });
  if (error) throw new WorkflowRefreshError(500, error.message);
  return data;
}

export async function consumeWorkflowRefresh(
  client: { rpc: Function },
  body: { owner?: string },
) {
  const owner = String(body.owner || "dispatch").trim();
  if (owner !== "dispatch") throw new WorkflowRefreshError(400, "workflow is not allowlisted");
  const { data, error } = await client.rpc("consume_workflow_refresh", {
    p_owner: owner,
  });
  if (error) throw new WorkflowRefreshError(500, error.message);
  return data;
}

export async function finishWorkflowRefresh(
  client: { rpc: Function },
  body: {
    id: string;
    status: string;
    result?: unknown;
    source_cutoff?: string;
    lease_token?: string;
    owner?: string;
  },
) {
  if (!body.lease_token || !body.owner) {
    throw new WorkflowRefreshError(400, "lease token and owner are required");
  }
  assertWorkflowRefreshBoundary({ workflow: body.owner });
  const { data, error } = await client.rpc("finish_workflow_refresh", {
    p_id: body.id,
    p_status: body.status,
    p_result: body.result ?? {},
    p_cutoff: body.source_cutoff ?? null,
    p_lease: body.lease_token,
    p_owner: body.owner,
  });
  if (error) throw new WorkflowRefreshError(500, error.message);
  return data;
}

export async function readWorkflowRefresh(
  client: { rpc: Function },
  id: string,
) {
  const { data, error } = await client.rpc("workflow_refresh_readback", { p_id: id });
  if (error) throw new WorkflowRefreshError(500, error.message);
  return data;
}

export async function startAndConsumeDispatchRefresh(
  client: { rpc: Function },
  body: { workflow?: string; scope?: Record<string, unknown>; actor?: string },
) {
  const started = await startWorkflowRefresh(client, body);
  if (String(body.workflow || "") !== "dispatch") return { start: started };
  if (started?.status === "queued" || started?.outcome === "started") {
    const consumed = await consumeDispatchRefresh(client, { id: started.id });
    const readback = await readWorkflowRefresh(client, started.id);
    return { start: started, consume: consumed, readback };
  }
  return { start: started, readback: await readWorkflowRefresh(client, started.id) };
}
