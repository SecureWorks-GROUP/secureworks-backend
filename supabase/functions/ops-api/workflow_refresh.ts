// Shared Refresh contract. UI may start/read. Workers claim/finish.
// A source-hash read is not completed Refresh. Unregistered drivers are unavailable.

export const WORKFLOW_REFRESH_OWNERS = [
  "dispatch",
  "debt",
  "ses",
  "booking",
  "performance",
] as const;

export const WORKFLOW_REFRESH_SCOPE_KEYS = ["job_id", "org_id", "week_start"] as const;
export const WORKFLOW_REFRESH_WORKER_OPS = ["claim", "finish", "consume"] as const;

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

export function bindRefreshOrg(
  scope: Record<string, unknown>,
  operatorOrgId: string,
) {
  if (scope.org_id && String(scope.org_id) !== operatorOrgId) {
    throw new WorkflowRefreshError(403, "operator organisation mismatch");
  }
  return { ...scope, org_id: operatorOrgId };
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

export function assertRefreshWorkerOp(authMode: string, op: string) {
  if (
    WORKFLOW_REFRESH_WORKER_OPS.includes(op as typeof WORKFLOW_REFRESH_WORKER_OPS[number]) &&
    authMode === "jwt"
  ) {
    throw new WorkflowRefreshError(403, "operators may request or read a run, not claim or finish it");
  }
}

export async function startWorkflowRefresh(
  client: { rpc: Function },
  body: { workflow?: string; scope?: Record<string, unknown>; actor?: string; org_id: string },
) {
  const { workflow, scope } = assertWorkflowRefreshBoundary(body);
  const actor = String(body.actor || "").trim();
  if (!actor) throw new WorkflowRefreshError(400, "actor is required");
  const bound = bindRefreshOrg(scope, body.org_id);
  const { data, error } = await client.rpc("start_workflow_refresh", {
    p_workflow: workflow,
    p_scope: bound,
    p_actor: actor,
    p_org_id: body.org_id,
  });
  if (error) throw new WorkflowRefreshError(500, error.message);
  return data;
}

export async function claimWorkflowRefresh(
  client: { rpc: Function },
  body: { id: string; owner?: string; lease_token?: string | null; lease_generation?: number | null },
) {
  const owner = String(body.owner || "dispatch").trim();
  assertWorkflowRefreshBoundary({ workflow: owner });
  const { data, error } = await client.rpc("claim_workflow_refresh", {
    p_id: body.id,
    p_owner: owner,
    p_lease: body.lease_token ?? null,
    p_generation: body.lease_generation ?? null,
  });
  if (error) throw new WorkflowRefreshError(500, error.message);
  return data;
}

export async function consumeWorkflowRefresh(
  client: { rpc: Function },
  body: { owner?: string },
) {
  const owner = String(body.owner || "").trim();
  if (!owner) throw new WorkflowRefreshError(400, "workflow is not allowlisted");
  assertWorkflowRefreshBoundary({ workflow: owner });
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
    lease_generation?: number;
    observed_source_revision?: string | null;
  },
) {
  if (!body.lease_token || !body.owner || body.lease_generation == null) {
    throw new WorkflowRefreshError(400, "lease token, owner and generation are required");
  }
  assertWorkflowRefreshBoundary({ workflow: body.owner });
  const { data, error } = await client.rpc("finish_workflow_refresh", {
    p_id: body.id,
    p_status: body.status,
    p_result: body.result ?? {},
    p_cutoff: body.source_cutoff ?? null,
    p_lease: body.lease_token,
    p_owner: body.owner,
    p_generation: body.lease_generation,
    p_observed_revision: body.observed_source_revision ?? null,
  });
  if (error) throw new WorkflowRefreshError(500, error.message);
  return data;
}

export async function readWorkflowRefresh(
  client: { rpc: Function },
  id: string,
  orgId: string,
) {
  const { data, error } = await client.rpc("workflow_refresh_readback", {
    p_id: id,
    p_org_id: orgId,
  });
  if (error) throw new WorkflowRefreshError(500, error.message);
  if (data && typeof data === "object" && "lease_token" in (data as object)) {
    throw new WorkflowRefreshError(500, "lease token must not be read back");
  }
  return data;
}
