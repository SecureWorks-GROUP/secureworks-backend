// deno-lint-ignore-file no-explicit-any
// Owner approval of the price and of the work order (TK-S28). Schema, policy
// and the only writers: 20261109040000_scope_owner_approvals.sql.
//
//   approve_scope_price        POST {job_id, scope_revision_id}
//       Records the price decision on a frozen (or superseded) saved revision.
//       Any draft job work order on that revision whose work order decision is
//       already recorded is issued in the same transaction.
//   approve_scope_work_order   POST {job_id, scope_revision_id, work_order_id,
//                                    expected_updated_at}
//       Records the work order decision on the draft exactly as read, on its
//       own saved revision. Issued when the price decision exists too (and,
//       for a shared-lane order, the customer's acceptance is retained).
//   read_scope_owner_approvals GET/POST {job_id}
//       Both decisions for the job's work order, its actual state, what its
//       issue waits for, and what the caller may approve.
//
// The approver is the signed-in user (or, while
// work_order_terminal_approval_v1 is on, a server-key call naming
// `user:<id>`). Who may approve is the database's owner_approval_authority;
// capabilities are worked out from it on the server, never from a client's
// role or a name. A browser never names the approver or its authority.

import {
  readFlag,
  readOwnerApprovalAuthority,
  WORK_ORDER_TERMINAL_APPROVAL_FLAG,
  type WorkOrderApprover,
} from "./job_work_orders.ts";

export type OwnerApprovalActor = {
  staff: boolean;
  orgId: string | null;
  approver: WorkOrderApprover | null;
};

export type OwnerApprovalCapabilities = {
  approve_price: boolean;
  approve_work_order: boolean;
  authority: string | null;
  reason: string | null;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What this caller may approve, from the database's authority rule. */
export async function ownerApprovalCapabilities(
  client: any,
  approver: WorkOrderApprover | null,
): Promise<OwnerApprovalCapabilities> {
  const none = (reason: string): OwnerApprovalCapabilities => ({
    approve_price: false,
    approve_work_order: false,
    authority: null,
    reason,
  });
  if (!approver) return none("approver_identity_missing");
  if (
    approver.via === "terminal" &&
    !(await readFlag(client, WORK_ORDER_TERMINAL_APPROVAL_FLAG))
  ) {
    return none("terminal_approval_switched_off");
  }
  let authority: string | null;
  try {
    authority = await readOwnerApprovalAuthority(client, approver.userId);
  } catch {
    return none("approvers_unreadable");
  }
  if (!authority) return none("approver_required");
  return {
    approve_price: true,
    approve_work_order: true,
    authority,
    reason: null,
  };
}

const RPC_CODES: Record<string, [number, string]> = {
  scope_owner_approval_job_forbidden: [403, "scope_owner_approval_job_forbidden"],
  scope_owner_approval_approver_required: [403, "approver_required"],
  scope_owner_approval_revision_not_found: [404, "scope_revision_not_found"],
  scope_owner_approval_revision_not_frozen: [409, "scope_revision_not_frozen"],
  scope_owner_approval_source_corrupt: [409, "scope_revision_source_corrupt"],
  scope_owner_approval_revision_conflict: [409, "work_order_revision_conflict"],
  scope_owner_approval_revision_mismatch: [409, "work_order_revision_mismatch"],
  scope_owner_approval_via_invalid: [400, "approval_via_invalid"],
};

const SQLSTATE_CODES: Record<string, [number, string]> = {
  "42501": [403, "approver_required"],
  "P0002": [404, "work_order_not_found"],
  "WO409": [409, "stale_review"],
  "WO428": [409, "owner_approval_required"],
  "23514": [409, "work_order_not_ready"],
};

function rpcFailure(error: any): { status: number; payload: unknown } {
  const message = String(error?.message ?? "");
  const named = RPC_CODES[message];
  if (named) return { status: named[0], payload: { code: named[1] } };
  const bySqlstate = SQLSTATE_CODES[String(error?.code ?? "")];
  if (bySqlstate) {
    return {
      status: bySqlstate[0],
      payload: { code: bySqlstate[1], error: message || undefined },
    };
  }
  return { status: 503, payload: { code: "owner_approval_unavailable" } };
}

function onlyKeys(input: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(input).every((k) => allowed.includes(k));
}

async function readState(client: any, jobId: string, orgId: string) {
  const { data, error } = await client.rpc("read_job_owner_approval_state", {
    p_job_id: jobId,
    p_org_id: orgId,
  });
  if (error) return { error };
  return { data };
}

export async function scopeOwnerApprovalsAction(
  client: any,
  action: string,
  method: string,
  body: unknown,
  actor: OwnerApprovalActor,
): Promise<Response> {
  const reply = (payload: unknown, status = 200) =>
    Response.json(payload, { status });
  if (!actor.staff || !actor.orgId) {
    return reply({ code: "operator_access_required" }, 403);
  }
  const input = (body && typeof body === "object" && !Array.isArray(body))
    ? body as Record<string, unknown>
    : {};
  const jobId = String(input.job_id ?? "");
  if (!UUID_RE.test(jobId)) {
    return reply({ code: "job_id_required" }, 400);
  }

  if (action === "read_scope_owner_approvals") {
    if (method !== "GET" && method !== "POST") {
      return reply({ code: "method_not_allowed" }, 405);
    }
    const state = await readState(client, jobId, actor.orgId);
    if (state.error) {
      const f = rpcFailure(state.error);
      return reply(f.payload, f.status);
    }
    return reply({
      ...state.data,
      capabilities: await ownerApprovalCapabilities(client, actor.approver),
    });
  }

  if (method !== "POST") return reply({ code: "method_not_allowed" }, 405);
  const revisionId = String(input.scope_revision_id ?? "");
  if (!UUID_RE.test(revisionId)) {
    return reply({ code: "scope_revision_id_required" }, 400);
  }
  const capabilities = await ownerApprovalCapabilities(client, actor.approver);
  if (!capabilities.approve_price || !actor.approver) {
    return reply({
      code: capabilities.reason ?? "approver_required",
      capabilities,
    }, capabilities.reason === "approvers_unreadable" ? 503 : 403);
  }

  if (action === "approve_scope_price") {
    if (!onlyKeys(input, ["job_id", "scope_revision_id"])) {
      return reply({
        code: "owner_approval_input_invalid",
        error: "Only job_id and scope_revision_id are accepted.",
      }, 400);
    }
    const { data, error } = await client.rpc("record_scope_price_approval", {
      p_job_id: jobId,
      p_scope_revision_id: revisionId,
      p_approver: actor.approver.userId,
      p_via: actor.approver.via,
      p_org_id: actor.orgId,
    });
    if (error) {
      const f = rpcFailure(error);
      return reply(f.payload, f.status);
    }
    const state = await readState(client, jobId, actor.orgId);
    return reply({
      ...data,
      state: state.error ? null : state.data,
      capabilities,
    });
  }

  if (action === "approve_scope_work_order") {
    if (
      !onlyKeys(input, [
        "job_id",
        "scope_revision_id",
        "work_order_id",
        "expected_updated_at",
      ])
    ) {
      return reply({
        code: "owner_approval_input_invalid",
        error:
          "Only job_id, scope_revision_id, work_order_id and expected_updated_at are accepted.",
      }, 400);
    }
    const workOrderId = String(input.work_order_id ?? "");
    if (!UUID_RE.test(workOrderId)) {
      return reply({ code: "work_order_id_required" }, 400);
    }
    const expected = input.expected_updated_at;
    if (
      typeof expected !== "string" || !Number.isFinite(Date.parse(expected))
    ) {
      return reply({
        code: "expected_updated_at_required",
        error:
          "Read the draft again and send its updated_at as expected_updated_at.",
      }, 400);
    }
    const { data: wo, error: woError } = await client.from("work_orders")
      .select("id, job_id, kind").eq("id", workOrderId).maybeSingle();
    if (woError) return reply({ code: "owner_approval_unavailable" }, 503);
    if (!wo) return reply({ code: "work_order_not_found" }, 404);
    if (wo.kind !== "job" || String(wo.job_id) !== jobId) {
      return reply({ code: "work_order_job_mismatch" }, 409);
    }
    const { data, error } = await client.rpc("record_job_work_order_approval", {
      p_work_order_id: workOrderId,
      p_approver: actor.approver.userId,
      p_via: actor.approver.via,
      p_expected_updated_at: expected,
      p_scope_revision_id: revisionId,
      p_org_id: actor.orgId,
      p_require_revision: true,
    });
    if (error) {
      const f = rpcFailure(error);
      return reply(f.payload, f.status);
    }
    const state = await readState(client, jobId, actor.orgId);
    return reply({
      ...data,
      state: state.error ? null : state.data,
      capabilities,
    });
  }

  return reply({ code: "unknown_action" }, 400);
}
