// ops-api doors for approved sends (the owner's recorded approval for one exact
// email or SMS). The rules live in ../_shared/approved_send.ts.
//
//   POST record_send_approval  the recording seat only. Dry run by default;
//                              a live record echoes the previewed hash.
//   POST send_approved         {approval_id} only. SMS is sent here; email is
//                              handed to send-outlook-email, which owns Graph
//                              and runs the same checks at the point of send.
//   GET  send_approval_status  ?approval_id=… the approval (no seal) and its
//                              audit, for the recording seat and operators.
//
// None of these is on ROUTINE_ALLOWED_ACTIONS or the agent-read allow-list,
// and none is exposed as an MCP tool.

import {
  ApprovedSendRefusal,
  assertApprovalRecorderAllowed,
  auditQuietly,
  readApprovalIdOnly,
  readApprovalStatus,
  type RecordDeps,
  recordApproval,
  type RecorderCredentialClass,
  type RecorderIdentity,
  type SendDeps,
} from "../_shared/approved_send.ts";
import {
  type ApprovedSmsDeps,
  type Caller,
  sendApprovedSms,
} from "../_shared/approved_send_sms.ts";

export interface ActionResult {
  status: number;
  body: Record<string, unknown>;
}

export interface OpsApiCredentialInput {
  authMode: "api_key" | "jwt" | "routine" | "agent_read";
  xApiKey: string | null;
  bearerToken: string | null;
  serviceKey: string | null | undefined;
  agentServerKey: string | null | undefined;
  sharedKey: string | null | undefined;
  routineKey: string | null | undefined;
}

/**
 * Which credential made this call. Mirrors _opsApiServerSecretPresented: a
 * server secret counts only when it is distinct from the shared browser key
 * and the routine key.
 */
export function approvedSendCredentialClass(
  input: OpsApiCredentialInput,
): RecorderCredentialClass {
  if (input.authMode === "jwt") return "user_jwt";
  if (input.authMode === "routine") return "routine";
  if (input.authMode === "agent_read") return "agent_read";
  const presented = (secret: string | null | undefined) =>
    !!secret &&
    secret !== input.sharedKey &&
    secret !== input.routineKey &&
    (input.xApiKey === secret || input.bearerToken === secret);
  if (presented(input.serviceKey)) return "service_role";
  if (presented(input.agentServerKey) && input.agentServerKey !== input.serviceKey) {
    return "ops_agent_server_key";
  }
  if (
    input.sharedKey &&
    (input.xApiKey === input.sharedKey || input.bearerToken === input.sharedKey)
  ) return "shared_key";
  return "none";
}

function refusalResult(error: ApprovedSendRefusal): ActionResult {
  return { status: error.status, body: { ...error.toBody(), retry_safe: false } };
}

export async function recordSendApprovalAction(
  deps: RecordDeps,
  identity: RecorderIdentity,
  body: Record<string, unknown>,
): Promise<ActionResult> {
  try {
    assertApprovalRecorderAllowed(identity);
    const result = await recordApproval(deps, identity, body);
    return { status: result.dry_run ? 200 : 201, body: { success: true, ...result } };
  } catch (error) {
    const refusal = error instanceof ApprovedSendRefusal
      ? error
      : new ApprovedSendRefusal(500, "approval_record_error",
        `The approval was not recorded (${(error as Error).message}).`);
    await auditQuietly(deps.store, {
      approval_id: null,
      event: "record_refused",
      channel: typeof body?.channel === "string" ? body.channel.slice(0, 16) : null,
      // Only a recognised recorder's name is kept; an unrecognised header value
      // is never echoed into the audit.
      actor: identity.actorSource === "header" ? identity.actor : null,
      credential_class: identity.credentialClass,
      code: refusal.code,
      detail: { fact: refusal.fact },
    });
    return refusalResult(refusal);
  }
}

export interface SendApprovedDeps extends ApprovedSmsDeps {
  /** Hand an email approval to send-outlook-email: {approval_id} only. */
  forwardEmail: (approvalId: string, caller: Caller) => Promise<ActionResult>;
}

export async function sendApprovedAction(
  deps: SendApprovedDeps,
  body: unknown,
  caller: Caller,
): Promise<ActionResult> {
  let approvalId: string | null = null;
  let channel: string | null = null;
  try {
    if (
      caller.credentialClass !== "service_role" &&
      caller.credentialClass !== "ops_agent_server_key"
    ) {
      throw new ApprovedSendRefusal(403, "approved_send_server_credential_required",
        "An approved send is made with a server credential.");
    }
    approvalId = readApprovalIdOnly(body);
    const row = await deps.store.loadApproval(approvalId);
    if (!row) {
      throw new ApprovedSendRefusal(404, "approval_not_found", "No recorded approval has this id.");
    }
    channel = row.channel;
    if (row.channel === "email") return await deps.forwardEmail(approvalId, caller);
    return await sendApprovedSms(deps, approvalId, caller);
  } catch (error) {
    const refusal = error instanceof ApprovedSendRefusal
      ? error
      : new ApprovedSendRefusal(500, "approved_send_error",
        `The approved send stopped before anything was sent (${(error as Error).message}).`);
    await auditQuietly(deps.store, {
      approval_id: approvalId,
      event: "send_refused",
      channel,
      actor: caller.actor,
      credential_class: caller.credentialClass,
      code: refusal.code,
      detail: { fact: refusal.fact, ...refusal.evidence },
    });
    return refusalResult(refusal);
  }
}

export async function sendApprovalStatusAction(
  deps: Pick<SendDeps, "store">,
  approvalId: unknown,
  credentialClass: RecorderCredentialClass,
): Promise<ActionResult> {
  try {
    if (credentialClass !== "service_role" && credentialClass !== "ops_agent_server_key") {
      throw new ApprovedSendRefusal(403, "approved_send_server_credential_required",
        "Approval status is read with a server credential.");
    }
    const id = readApprovalIdOnly({ approval_id: approvalId });
    return { status: 200, body: await readApprovalStatus(deps.store, id) };
  } catch (error) {
    if (error instanceof ApprovedSendRefusal) return refusalResult(error);
    throw error;
  }
}

/** Server-to-server hand-off of an email approval to send-outlook-email. */
export function makeForwardEmail(
  supabaseUrl: string,
  serviceKey: string,
  fetchImpl: typeof fetch = fetch,
): SendApprovedDeps["forwardEmail"] {
  return async (approvalId, caller) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceKey}`,
    };
    if (caller.actor && caller.actor !== "actor_missing") headers["x-sw-actor"] = caller.actor;
    let response: Response;
    try {
      response = await fetchImpl(`${supabaseUrl}/functions/v1/send-outlook-email`, {
        method: "POST",
        headers,
        body: JSON.stringify({ approval_id: approvalId }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (error) {
      // The email function may have claimed and sent; its own record says.
      return {
        status: 502,
        body: {
          state: "outcome_unknown",
          code: "email_handoff_outcome_unknown",
          approval_id: approvalId,
          error: (error as Error).message,
          retry_safe: false,
          recovery_action:
            "Read send_approval_status for this approval before anything else; never record a new approval until it shows the outcome.",
        },
      };
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = await response.json();
    } catch {
      parsed = { state: "outcome_unknown", code: "email_handoff_unreadable", retry_safe: false };
    }
    return { status: response.status, body: parsed };
  };
}
