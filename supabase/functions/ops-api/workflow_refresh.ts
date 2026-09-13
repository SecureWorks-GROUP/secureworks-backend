// Shared Refresh contract. UI may start/read. Workers claim/finish.
// A source-hash read is not completed Refresh. Unregistered drivers are unavailable.

export const WORKFLOW_REFRESH_OWNERS = [
  "dispatch",
  "debt",
  "ses",
  "booking",
  "performance",
] as const;

export const WORKFLOW_REFRESH_SCOPE_KEYS = [
  "job_id",
  "org_id",
  "week_start",
  "xero_invoice_id",
  "population",
] as const;
export const WORKFLOW_REFRESH_WORKER_OPS = [
  "claim",
  "finish",
  "consume",
] as const;

type WorkflowRefreshRpcData = Record<string, unknown> & {
  outcome?: string;
  status?: string;
  receipt_id?: string;
  observed_source_revision?: string | null;
};

type WorkflowRefreshRpcResult = {
  data: WorkflowRefreshRpcData | null;
  error: { message: string } | null;
};

type WorkflowRefreshClient = {
  rpc: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<WorkflowRefreshRpcResult>;
};

export type WorkflowRefreshReceipt = {
  driver_version: string;
  scope: Record<string, unknown>;
  output: Record<string, unknown>;
  observed_source_revision: string;
};

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
  if (
    !WORKFLOW_REFRESH_OWNERS.includes(
      workflow as typeof WORKFLOW_REFRESH_OWNERS[number],
    )
  ) {
    throw new WorkflowRefreshError(400, "workflow is not allowlisted");
  }
  const scope = body.scope && typeof body.scope === "object" ? body.scope : {};
  for (const key of Object.keys(scope)) {
    if (
      !WORKFLOW_REFRESH_SCOPE_KEYS.includes(
        key as typeof WORKFLOW_REFRESH_SCOPE_KEYS[number],
      )
    ) {
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
    if (!authUser?.id) {
      throw new WorkflowRefreshError(401, "named operator required");
    }
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
    WORKFLOW_REFRESH_WORKER_OPS.includes(
      op as typeof WORKFLOW_REFRESH_WORKER_OPS[number],
    ) &&
    authMode === "jwt"
  ) {
    throw new WorkflowRefreshError(
      403,
      "operators may request or read a run, not claim or finish it",
    );
  }
}

export async function startWorkflowRefresh(
  client: WorkflowRefreshClient,
  body: {
    workflow?: string;
    scope?: Record<string, unknown>;
    actor?: string;
    org_id: string;
  },
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
  return data as WorkflowRefreshRpcData;
}

export async function claimWorkflowRefresh(
  client: WorkflowRefreshClient,
  body: {
    id: string;
    owner?: string;
    lease_token?: string | null;
    lease_generation?: number | null;
  },
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
  return data as WorkflowRefreshRpcData;
}

export async function consumeWorkflowRefresh(
  client: WorkflowRefreshClient,
  body: { owner?: string },
) {
  const owner = String(body.owner || "").trim();
  if (!owner) {
    throw new WorkflowRefreshError(400, "workflow is not allowlisted");
  }
  assertWorkflowRefreshBoundary({ workflow: owner });
  const { data, error } = await client.rpc("consume_workflow_refresh", {
    p_owner: owner,
  });
  if (error) throw new WorkflowRefreshError(500, error.message);
  return data as WorkflowRefreshRpcData;
}

export async function finishWorkflowRefresh(
  client: WorkflowRefreshClient,
  body: {
    id: string;
    status: string;
    result?: unknown;
    source_cutoff?: string;
    lease_token?: string;
    owner?: string;
    lease_generation?: number;
    observed_source_revision?: string | null;
    receipt?: WorkflowRefreshReceipt;
  },
) {
  if (!body.lease_token || !body.owner || body.lease_generation == null) {
    throw new WorkflowRefreshError(
      400,
      "lease token, owner and generation are required",
    );
  }
  assertWorkflowRefreshBoundary({ workflow: body.owner });
  if (body.status === "completed" && !body.receipt) {
    throw new WorkflowRefreshError(
      400,
      "completed Refresh requires a persisted driver receipt",
    );
  }
  let result = body.result ?? {};
  let observedRevision = body.observed_source_revision ?? null;
  if (body.receipt) {
    const receipt = await recordWorkflowRefreshReceipt(client, {
      id: body.id,
      owner: body.owner,
      lease_token: body.lease_token,
      lease_generation: body.lease_generation,
      receipt: body.receipt,
    });
    observedRevision = receipt.observed_source_revision;
    if (result && typeof result === "object" && !Array.isArray(result)) {
      result = {
        ...(result as Record<string, unknown>),
        receipt_id: receipt.receipt_id,
      };
    } else {
      result = { receipt_id: receipt.receipt_id };
    }
  }
  const { data, error } = await client.rpc("finish_workflow_refresh", {
    p_id: body.id,
    p_status: body.status,
    p_result: result,
    p_cutoff: body.source_cutoff ?? null,
    p_lease: body.lease_token,
    p_owner: body.owner,
    p_generation: body.lease_generation,
    p_observed_revision: observedRevision,
  });
  if (error) throw new WorkflowRefreshError(500, error.message);
  return data as WorkflowRefreshRpcData;
}

export async function recordWorkflowRefreshReceipt(
  client: WorkflowRefreshClient,
  body: {
    id: string;
    owner: string;
    lease_token: string;
    lease_generation: number;
    receipt: WorkflowRefreshReceipt;
  },
) {
  const { data, error } = await client.rpc("record_workflow_refresh_receipt", {
    p_run_id: body.id,
    p_owner: body.owner,
    p_lease: body.lease_token,
    p_generation: body.lease_generation,
    p_driver_version: body.receipt.driver_version,
    p_scope: body.receipt.scope,
    p_output: body.receipt.output,
    p_observed_revision: body.receipt.observed_source_revision,
  });
  if (error) throw new WorkflowRefreshError(500, error.message);
  if (
    !data || typeof data !== "object" ||
    typeof (data as { receipt_id?: unknown }).receipt_id !== "string" ||
    typeof (data as { observed_source_revision?: unknown })
        .observed_source_revision !== "string" ||
    !(data as { observed_source_revision: string }).observed_source_revision
      .trim()
  ) {
    throw new WorkflowRefreshError(
      500,
      "receipt persistence returned no receipt id or source revision",
    );
  }
  return data as {
    receipt_id: string;
    outcome?: string;
    observed_source_revision: string;
  };
}

export async function readWorkflowRefresh(
  client: WorkflowRefreshClient,
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
