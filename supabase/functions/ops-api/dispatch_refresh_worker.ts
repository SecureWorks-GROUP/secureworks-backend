import {
  dispatchCommand,
  DispatchError,
  hash,
  readDispatchJob,
  uuid,
} from "./dispatch_workbench.ts";
import {
  DISPATCH_REFRESH_OUTPUT,
  operatorRefreshResult,
  pendingRefreshDoor,
} from "./dispatch_refresh_driver.ts";

export type DispatchRefreshClaim = {
  id: string;
  org_id: string;
  scope: { org_id: string; job_id: string };
  owner: "dispatch";
  lease_token: string;
  generation: number;
};

function assertClaim(org: string, claim: DispatchRefreshClaim) {
  if (
    !claim || claim.owner !== "dispatch" || claim.org_id !== org ||
    claim.scope?.org_id !== org ||
    Object.keys(claim.scope).some((key) =>
      !["org_id", "job_id"].includes(key)
    ) ||
    !claim.lease_token || typeof claim.lease_token !== "string" ||
    !Number.isSafeInteger(claim.generation) || claim.generation < 1
  ) {
    throw new DispatchError(
      "Invalid claimed Dispatch Refresh scope or lease",
      409,
    );
  }
  uuid(claim.id);
  uuid(claim.scope.job_id);
}

function missingRpc(error: { code?: string }) {
  return ["PGRST202", "42883"].includes(error.code || "");
}

export async function runClaimedDispatchRefresh(
  client: any,
  org: string,
  claim: DispatchRefreshClaim,
) {
  claim = structuredClone(claim);
  assertClaim(org, claim);
  const sourceCutoff = new Date().toISOString();
  const jobId = claim.scope.job_id;
  const current = await readDispatchJob(client, org, jobId);
  const requestId = crypto.randomUUID();
  const actor = `dispatch-refresh:${claim.id}:${claim.generation}`;
  await dispatchCommand(client, org, actor, {
    job_id: jobId,
    expected_version: current.version,
    source_version: current.source_version,
    request_id: requestId,
    command: "assess",
    payload: {},
  });
  const [commandRead, planRead] = await Promise.all([
    client.from("dispatch_commands").select(
      "org_id,job_id,request_id,actor,command,result",
    ).eq("org_id", org).eq("job_id", jobId).eq("request_id", requestId)
      .maybeSingle(),
    client.from("dispatch_plans").select(
      "org_id,job_id,version,source_version,state",
    ).eq("org_id", org).eq("job_id", jobId).maybeSingle(),
  ]);
  if (commandRead.error || planRead.error) {
    throw new DispatchError("Persisted Refresh output could not be read", 503);
  }
  const command = commandRead.data, plan = planRead.data;
  const assessment = plan?.state?.assessment;
  if (
    !command || !plan || command.org_id !== org || command.job_id !== jobId ||
    command.request_id !== requestId || command.actor !== actor ||
    command.command !== "assess" || plan.org_id !== org ||
    plan.job_id !== jobId ||
    plan.version !== current.version + 1 ||
    command.result?.version !== plan.version || !plan.source_version ||
    command.result?.source_version !== plan.source_version ||
    !assessment || assessment.source_version !== plan.source_version ||
    assessment.stale !== false || !Array.isArray(assessment.obligations) ||
    typeof assessment.assessed_at !== "string" ||
    !Number.isFinite(Date.parse(assessment.assessed_at)) ||
    Date.parse(assessment.assessed_at) < Date.parse(sourceCutoff) ||
    await hash(command.result.state) !== await hash(plan.state)
  ) {
    throw new DispatchError(
      "Refresh requires a matching persisted assessment",
      409,
    );
  }
  const sourceRead = await client.rpc("dispatch_source_version", {
    p_org: org,
    p_job: jobId,
  });
  if (sourceRead.error || sourceRead.data !== plan.source_version) {
    throw new DispatchError("Refresh source changed after assessment", 409);
  }
  const receipt = {
    driver_version: DISPATCH_REFRESH_OUTPUT,
    scope: structuredClone(claim.scope),
    observed_source_revision: plan.source_version,
    output: {
      ok: "true",
      declared_output: DISPATCH_REFRESH_OUTPUT,
      observed_source_revision: plan.source_version,
      work: {
        jobs_read: 1,
        source_cutoff: sourceCutoff,
        missing_materials: assessment.obligations.filter((
          item: { code: string },
        ) =>
          [
            "complete_set_unreviewed",
            "requirement_review",
            "supply_gap",
            "site_receipt_gap",
            "supply_reconciliation",
            "allocation_suitability",
          ].includes(item.code)
        ),
        missing_order_evidence: assessment.obligations.filter((
          item: { code: string },
        ) =>
          ["complete_set_unreviewed", "requirement_review", "supply_gap"]
            .includes(item.code)
        ),
      },
      output_ref: {
        table: "dispatch_commands",
        command: "assess",
        request_id: requestId,
      },
    },
  };
  const coordinates = {
    p_owner: claim.owner,
    p_lease: claim.lease_token,
    p_generation: claim.generation,
  };
  const recorded = await client.rpc("record_workflow_refresh_receipt", {
    ...coordinates,
    p_run_id: claim.id,
    p_driver_version: receipt.driver_version,
    p_scope: receipt.scope,
    p_output: receipt.output,
    p_observed_revision: plan.source_version,
  });
  if (recorded.error) {
    if (missingRpc(recorded.error)) {
      return {
        ...pendingRefreshDoor("dispatch_refresh_receipt_rpc_missing"),
        id: claim.id,
        receipt,
      };
    }
    throw new DispatchError(recorded.error.message, 409);
  }
  if (
    !recorded.data || recorded.data.outcome === "unavailable" ||
    recorded.data.ok === false
  ) {
    return {
      ...pendingRefreshDoor("dispatch_refresh_receipt_unverified"),
      id: claim.id,
      receipt,
    };
  }
  const finished = await client.rpc("finish_workflow_refresh", {
    ...coordinates,
    p_id: claim.id,
    p_status: "completed",
    p_result: receipt.output,
    p_cutoff: sourceCutoff,
    p_observed_revision: plan.source_version,
  });
  if (finished.error) {
    if (missingRpc(finished.error)) {
      return {
        ...pendingRefreshDoor("dispatch_refresh_finish_rpc_missing"),
        id: claim.id,
        receipt,
      };
    }
    throw new DispatchError(finished.error.message, 409);
  }
  return {
    ...(operatorRefreshResult(finished.data) ??
      pendingRefreshDoor("dispatch_refresh_finish_unavailable")),
    id: claim.id,
    receipt,
  };
}

export async function runDispatchRefreshWorker(client: any, org: string) {
  if (!org) throw new DispatchError("Worker organisation required", 403);
  if (typeof client.rpc !== "function") return pendingRefreshDoor();
  const claimed = await client.rpc("claim_workflow_refresh", {
    p_workflow: "dispatch",
    p_org_id: org,
    p_owner: "dispatch",
  });
  if (claimed.error) {
    if (missingRpc(claimed.error)) return pendingRefreshDoor();
    throw new DispatchError(claimed.error.message, 409);
  }
  if (!claimed.data) return { outcome: "idle", workflow: "dispatch" };
  if (claimed.data.outcome === "unavailable") {
    return pendingRefreshDoor("dispatch_refresh_driver_unavailable");
  }
  return runClaimedDispatchRefresh(client, org, claimed.data);
}
