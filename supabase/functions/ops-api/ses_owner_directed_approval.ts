// Owner-directed SES invoice approval (owner, 12 Nov 2026).
//
// THE TRUST STATEMENT. An SES invoice approval is normally an identified human
// pressing APPROVE INVOICE in their own signed-in session
// (`canRecordSesApproval`, untouched), or the echo-code text approval. This is
// a THIRD way, asked for by the business owner so that he can approve from a
// conversation with an agent: the agent, calling with the server key, names the
// operator who told it to approve and quotes that operator's words. The
// approval is then recorded against that operator through the SAME
// `approveSesInvoiceRevisionAction` a cockpit press calls, so every guard on
// WHAT may be approved (echoed review coordinates, stale review, existing card
// money, decision-blocked bands) runs unchanged. It changes WHO may approve,
// never WHAT.
//
// It is weaker than a session, and says so: the server key is not the
// operator. Any holder of the server key could name an operator. So it is
// fenced three ways, and recorded so nobody reads it as a session:
//   1. Off unless `feature_flags.ses_owner_directed_approval_v1` is on
//      (missing or unreadable is off).
//   2. Server key only (`api_key`): never a routine, never a browser session
//      (a signed-in operator should press the button themselves).
//   3. The named operator must be an ACTIVE `ses_release_operators` row of
//      class `admin_owner` or `captain`, matched by exact email, and the
//      operator's own words must be quoted.
// The recorded auth carries `identity_provenance: "owner_directed_via_agent"`
// and the approval's evidence_refs carry the quoted words and the relaying
// actor. The `ses_channel_enrolment` gate already refuses any auth that carries
// a provenance, so this identity can never bootstrap a channel seed.

import type { SesActionAuth } from "./ses_reporting_actions.ts";

export const SES_OWNER_DIRECTED_APPROVAL_FLAG = "ses_owner_directed_approval_v1";
export const SES_OWNER_DIRECTED_OPERATOR_CLASSES = ["admin_owner", "captain"] as const;

export interface SesOwnerDirectedRequest {
  owner_email?: unknown;
  owner_statement?: unknown;
}

export type SesOwnerDirectedResult =
  | {
    ok: true;
    auth: SesActionAuth;
    evidence_ref: Record<string, unknown>;
  }
  | {
    ok: false;
    status: number;
    refusal: { state: "refused"; code: string; fact: string; recovery_action: string };
  };

function refuse(
  status: number,
  code: string,
  fact: string,
  recovery_action: string,
): SesOwnerDirectedResult {
  return { ok: false, status, refusal: { state: "refused", code, fact, recovery_action } };
}

export async function sesOwnerDirectedApprovalEnabled(client: any): Promise<boolean> {
  try {
    const { data, error } = await client.from("feature_flags")
      .select("enabled")
      .eq("flag_name", SES_OWNER_DIRECTED_APPROVAL_FLAG)
      .limit(1);
    if (error) {
      console.error(
        "[ops-api] owner-directed approval flag unreadable, treating as off:",
        error.message || error,
      );
      return false;
    }
    return Array.isArray(data) && data[0]?.enabled === true;
  } catch (e) {
    console.error("[ops-api] owner-directed approval flag read threw, treating as off:", e);
    return false;
  }
}

/**
 * Resolve the operator an agent says directed the approval. Pure decision over
 * the reads; returns the auth to hand to `approveSesInvoiceRevisionAction`.
 */
export async function resolveSesOwnerDirectedApproval(
  client: any,
  authMode: "api_key" | "jwt" | "routine",
  request: SesOwnerDirectedRequest,
  relayedBy: string | null,
): Promise<SesOwnerDirectedResult> {
  if (authMode !== "api_key") {
    return refuse(
      403,
      "owner_directed_server_key_only",
      "An owner-directed approval is relayed by an agent with the server key. A signed-in operator presses APPROVE INVOICE instead; a routine may never approve.",
      "Sign in and press APPROVE INVOICE, or relay the owner's words from an agent seat.",
    );
  }
  if (!(await sesOwnerDirectedApprovalEnabled(client))) {
    return refuse(
      409,
      "owner_directed_approval_off",
      `Owner-directed approval is switched off (feature_flags.${SES_OWNER_DIRECTED_APPROVAL_FLAG}).`,
      "The owner turns the switch on, or approves in the cockpit.",
    );
  }
  const email = String(request.owner_email ?? "").trim().toLowerCase();
  const statement = String(request.owner_statement ?? "").trim();
  if (!email || !email.includes("@")) {
    return refuse(
      400,
      "owner_email_required",
      "Name the operator who directed this approval by their sign-in email (owner_email).",
      "Resend with owner_email.",
    );
  }
  if (statement.length < 3) {
    return refuse(
      400,
      "owner_statement_required",
      "Quote the operator's own words approving this invoice (owner_statement).",
      "Resend with the operator's words, verbatim.",
    );
  }
  const { data: users, error: userError } = await client.from("users")
    .select("id,email,role")
    .ilike("email", email)
    .limit(2);
  if (userError) {
    return refuse(503, "owner_unreadable", `The named operator could not be read (${userError.message}).`, "Retry.");
  }
  const matches = (users || []).filter((u: any) => String(u.email || "").trim().toLowerCase() === email);
  if (matches.length !== 1) {
    return refuse(
      403,
      "owner_not_found",
      `No single user is signed in as ${email}.`,
      "Name the operator by their exact sign-in email.",
    );
  }
  const user = matches[0];
  const { data: operators, error: operatorError } = await client.from("ses_release_operators")
    .select("user_id,operator_class,active")
    .eq("user_id", user.id)
    .limit(1);
  if (operatorError) {
    return refuse(503, "owner_operator_unreadable", `The operator record could not be read (${operatorError.message}).`, "Retry.");
  }
  const operator = Array.isArray(operators) ? operators[0] : null;
  if (
    !operator || operator.active !== true ||
    !(SES_OWNER_DIRECTED_OPERATOR_CLASSES as readonly string[]).includes(String(operator.operator_class))
  ) {
    return refuse(
      403,
      "owner_not_an_approving_operator",
      `${email} is not an active SES operator of class admin_owner or captain, so their word cannot approve an invoice.`,
      "Only an active admin_owner or captain operator may direct an approval.",
    );
  }
  return {
    ok: true,
    auth: {
      mode: "jwt",
      user: { id: String(user.id), email: String(user.email), role: String(user.role || "") },
      identity_provenance: "owner_directed_via_agent",
    },
    evidence_ref: {
      kind: "owner_directive",
      owner_email: email,
      owner_statement: statement,
      relayed_by: relayedBy || "unnamed server-key caller",
      recorded_at: new Date().toISOString(),
    },
  };
}
