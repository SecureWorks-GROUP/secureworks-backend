// Slice EM1 (email.md §13a, review S13): the one ops door that changes which
// Outlook sources email capture reads.
//
//   POST ?action=set_monitored_mailbox
//        {email, enabled?, status?, reason}
//     -> RPC set_monitored_mailbox(p_email, p_enabled, p_status, p_reason,
//        p_actor), the one writer of monitored_mailboxes after the EM1 seed.
//
// It changes only `enabled` and/or `status` ('active' | 'pending_review') of a
// source that already exists; adding or removing a source is a migration.
// The actor (INTEGRATION X31) is recorded as `updated_by` and on the
// monitored_mailbox_changes receipt. A missing actor is recorded as
// `actor_missing`, never refused.
//
// Who may call: the privileged server key, or a signed-in admin or owner of
// the company organisation. Choosing whose mailbox the system reads is an
// owner-level decision, so this gate is deliberately stricter than the staff
// set (ops_manager is refused), like the other admin/owner surfaces.
//
// One log line per call: action, email (a company mailbox, never customer
// data), outcome or refusal code, actor. The reason text is not logged.

export class MonitoredMailboxError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface SetMonitoredMailboxInput {
  email: string;
  enabled: boolean | null;
  status: "active" | "pending_review" | null;
  reason: string;
}

const ADDRESS = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const STATES = new Set(["active", "pending_review"]);
const BODY_KEYS = new Set(["email", "enabled", "status", "reason"]);

/** The in-route gate: the privileged server key, or an admin or owner of
 * the company organisation. */
export function canChangeMonitoredMailboxes(
  authMode: string,
  authUser: { role?: unknown; orgId?: unknown } | null | undefined,
  companyOrgId: string,
): boolean {
  if (authMode === "api_key") return true;
  if (authMode !== "jwt" || !authUser) return false;
  const role = String(authUser.role ?? "").toLowerCase();
  return (role === "admin" || role === "owner") &&
    String(authUser.orgId ?? "") === companyOrgId;
}

/** Validates the POST body. Refuses unknown keys so a misspelt field is never
 * silently ignored. */
export function parseSetMonitoredMailboxBody(
  body: unknown,
): SetMonitoredMailboxInput {
  const bad = (message: string) =>
    new MonitoredMailboxError("monitored_mailbox_request_invalid", 400, message);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw bad("A JSON object body is required.");
  }
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !BODY_KEYS.has(k));
  if (unknown.length) throw bad(`Unknown field: ${unknown.sort().join(", ")}.`);
  const email = typeof b.email === "string"
    ? b.email.trim().toLowerCase()
    : "";
  if (!ADDRESS.test(email) || email.length > 254) {
    throw bad("email must be a mailbox address.");
  }
  if (b.enabled !== undefined && b.enabled !== null && typeof b.enabled !== "boolean") {
    throw bad("enabled must be true or false.");
  }
  if (
    b.status !== undefined && b.status !== null &&
    !(typeof b.status === "string" && STATES.has(b.status))
  ) {
    throw bad("status must be active or pending_review.");
  }
  const enabled = typeof b.enabled === "boolean" ? b.enabled : null;
  const status = typeof b.status === "string"
    ? b.status as "active" | "pending_review"
    : null;
  if (enabled === null && status === null) {
    throw bad("Name enabled, status, or both.");
  }
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  const hasControl = [...reason].some((c) => {
    const code = c.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
  if (reason.length < 3 || reason.length > 300 || hasControl) {
    throw bad("reason is required: 3 to 300 characters on one line.");
  }
  return { email, enabled, status, reason };
}

// Refusals raised by set_monitored_mailbox(), by status.
const REFUSALS: Record<string, number> = {
  monitored_mailbox_unknown: 404,
  monitored_mailbox_enable_requires_active: 409,
  monitored_mailbox_kind_unknown: 409,
  monitored_mailbox_reason_invalid: 400,
  monitored_mailbox_status_invalid: 400,
  monitored_mailbox_change_missing: 400,
  monitored_mailbox_actor_invalid: 400,
};

const MESSAGES: Record<string, string> = {
  monitored_mailbox_unknown:
    "No such monitored mailbox. Adding a source is a migration.",
  monitored_mailbox_enable_requires_active:
    "Only a source in status active can be enabled; set status active first (it must have been located and verified).",
  monitored_mailbox_kind_unknown:
    "This address has not been located as a user mailbox or group yet; it stays pending_review.",
};

type RpcClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

export async function setMonitoredMailbox(
  client: RpcClient,
  body: unknown,
  actor: string,
): Promise<Record<string, unknown>> {
  const input = parseSetMonitoredMailboxBody(body);
  const { data, error } = await client.rpc("set_monitored_mailbox", {
    p_email: input.email,
    p_enabled: input.enabled,
    p_status: input.status,
    p_reason: input.reason,
    p_actor: actor,
  });
  if (error || !data || typeof data !== "object") {
    const e = (error && typeof error === "object" ? error : {}) as {
      message?: unknown;
      code?: unknown;
    };
    const message = typeof e.message === "string" ? e.message.trim() : "";
    const status = REFUSALS[message];
    console.log(JSON.stringify({
      event: "set_monitored_mailbox",
      email: input.email,
      refused: status ? message : "rpc_failed",
      code: typeof e.code === "string" ? e.code : null,
      actor,
    }));
    if (status) {
      throw new MonitoredMailboxError(
        message,
        status,
        MESSAGES[message] ?? "The change was refused.",
      );
    }
    throw new MonitoredMailboxError(
      "monitored_mailbox_unavailable",
      503,
      "The mailbox list could not be changed.",
    );
  }
  const result = data as Record<string, unknown>;
  console.log(JSON.stringify({
    event: "set_monitored_mailbox",
    email: input.email,
    outcome: result.outcome ?? null,
    actor,
  }));
  return result;
}
