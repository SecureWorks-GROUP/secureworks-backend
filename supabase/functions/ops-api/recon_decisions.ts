// Context reconciliation (CTX-R1, 20261020140000 and 20261020160000): the
// ops-api doors onto the reconciliation decision store.
//
//   GET  ?action=recon_daily_list[&limit=n]
//     -> RPC context_recon_daily_list(p_as_of, p_limit): the resolver's list,
//        ranked by consequence (owed invoices with no job, then messages from a
//        contact who owes, then recent customer messages on a live job).
//   POST ?action=recon_record_decision
//     { subject_kind: event|invoice, subject_id, shown_hash, action, job_ids?,
//       cause, escalate_to? }
//     -> RPC context_recon_record_decision (event) or
//        context_recon_record_invoice_decision (invoice).
//
// The person is the verified session user, never a body field: a server key
// call has no person behind it and is refused (V-4). Staff only at the front
// door (admin, owner, ops_manager); the SQL writer checks users.role again and
// refuses anyone else. A decision records attribution only: it never writes an
// invoice, a ledger item, a payment or a permission to pay.

export class ReconDecisionError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const RECON_EVENT_ACTIONS = [
  "confirm",
  "correct",
  "split",
  "unrelated",
  "unresolved",
  "escalate",
] as const;

export const RECON_INVOICE_ACTIONS = [
  "correct",
  "unrelated",
  "unresolved",
  "escalate",
] as const;

export const RECON_ESCALATE_TO = ["finance", "sales", "owner"] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{32}$/;
const CAUSE = /^(ambiguity|defect):[a-z_]{1,40}$/;

// SQL refusals (the exception message the writer raises) and what each means
// to the caller.
const REFUSALS: Record<string, [string, number, string]> = {
  recon_not_staff: [
    "not_staff",
    403,
    "Only admin, owner or ops manager can record a decision.",
  ],
  recon_evidence_changed_since_shown: [
    "evidence_changed",
    409,
    "This item changed since it was shown. Reload the list and decide again.",
  ],
  recon_subject_not_found: ["subject_not_found", 404, "That item was not found."],
  recon_job_not_found: ["job_not_found", 404, "That job was not found."],
  recon_confirm_needs_offered_job: [
    "job_not_offered",
    422,
    "Confirm only picks a job the item offered. Use correct to name another job.",
  ],
  recon_invoice_action_not_allowed: [
    "action_not_allowed",
    422,
    "An invoice can be corrected, marked unrelated, left unresolved or escalated.",
  ],
};

type Rpc = {
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

export type ReconCaller = {
  authMode: string;
  userId: string | null | undefined;
};

function bad(message: string): never {
  throw new ReconDecisionError("invalid_request", 400, message);
}

// The person behind the call: only a verified user session has one.
export function reconDecisionUser(caller: ReconCaller): string {
  if (
    caller.authMode !== "jwt" || !caller.userId || !UUID.test(caller.userId)
  ) {
    throw new ReconDecisionError(
      "person_session_required",
      403,
      "A decision is made by a signed-in staff member, not a server key.",
    );
  }
  return caller.userId;
}

export function reconDailyListArgs(
  params: URLSearchParams,
  now: Date = new Date(),
): Record<string, unknown> {
  const raw = params.get("limit");
  let limit = 50;
  if (raw !== null) {
    if (!/^\d{1,3}$/.test(raw)) bad("limit must be a whole number");
    limit = Number(raw);
    if (limit < 1 || limit > 200) bad("limit must be between 1 and 200");
  }
  return { p_as_of: now.toISOString(), p_limit: limit };
}

export function reconRecordDecisionCall(
  body: unknown,
  userId: string,
): { fn: string; args: Record<string, unknown> } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    bad("body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  const allowed = new Set([
    "subject_kind",
    "subject_id",
    "shown_hash",
    "action",
    "job_ids",
    "cause",
    "escalate_to",
  ]);
  for (const key of Object.keys(b)) {
    if (!allowed.has(key)) bad(`unknown field ${key}`);
  }
  const kind = String(b.subject_kind ?? "");
  if (kind !== "event" && kind !== "invoice") {
    bad("subject_kind must be event or invoice");
  }
  const subjectId = String(b.subject_id ?? "");
  if (!UUID.test(subjectId)) bad("subject_id must be a uuid");
  const hash = String(b.shown_hash ?? "");
  if (!HASH.test(hash)) bad("shown_hash must be the hash the list showed");
  const action = String(b.action ?? "");
  const actions: readonly string[] = kind === "invoice"
    ? RECON_INVOICE_ACTIONS
    : RECON_EVENT_ACTIONS;
  if (!actions.includes(action)) {
    bad(`action must be one of ${actions.join(", ")}`);
  }
  const cause = String(b.cause ?? "");
  if (!CAUSE.test(cause)) bad("cause must be the cause the list showed");

  const rawJobs = b.job_ids ?? [];
  if (!Array.isArray(rawJobs) || rawJobs.length > 10) {
    bad("job_ids must be a list of at most 10 job ids");
  }
  const jobIds = (rawJobs as unknown[]).map((j) => String(j));
  if (jobIds.some((j) => !UUID.test(j))) bad("job_ids must be uuids");
  if (new Set(jobIds).size !== jobIds.length) bad("job_ids must not repeat");
  const want = action === "confirm" || action === "correct"
    ? "one"
    : action === "split"
    ? "several"
    : "none";
  if (want === "one" && jobIds.length !== 1) bad(`${action} needs one job`);
  if (want === "several" && jobIds.length < 2) bad("split needs two or more jobs");
  if (want === "none" && jobIds.length !== 0) bad(`${action} takes no job`);

  let escalateTo: string | null = null;
  if (action === "escalate") {
    escalateTo = String(b.escalate_to ?? "");
    if (!(RECON_ESCALATE_TO as readonly string[]).includes(escalateTo)) {
      bad(`escalate_to must be one of ${RECON_ESCALATE_TO.join(", ")}`);
    }
  } else if (b.escalate_to !== undefined && b.escalate_to !== null) {
    bad("escalate_to is only used to escalate");
  }

  const args: Record<string, unknown> = {
    p_shown_hash: hash,
    p_action: action,
    p_job_ids: jobIds,
    p_cause: cause,
    p_user_id: userId,
    p_escalate_to: escalateTo,
  };
  if (kind === "invoice") {
    return {
      fn: "context_recon_record_invoice_decision",
      args: { p_invoice: subjectId, ...args },
    };
  }
  return {
    fn: "context_recon_record_decision",
    args: { p_event: subjectId, ...args },
  };
}

function refusal(error: unknown): ReconDecisionError | null {
  const message = String((error as { message?: unknown })?.message ?? "");
  const hit = REFUSALS[message];
  return hit ? new ReconDecisionError(hit[0], hit[1], hit[2]) : null;
}

export async function reconDailyList(
  client: Rpc,
  params: URLSearchParams,
  now: Date = new Date(),
): Promise<Record<string, unknown>> {
  const args = reconDailyListArgs(params, now);
  const { data, error } = await client.rpc("context_recon_daily_list", args);
  if (error) {
    console.error("[recon_daily_list] read failed", error);
    throw new ReconDecisionError(
      "daily_list_unreadable",
      502,
      "The daily list could not be read.",
    );
  }
  const items = Array.isArray(data) ? data : [];
  return { as_of: args.p_as_of, limit: args.p_limit, count: items.length, items };
}

export async function reconRecordDecision(
  client: Rpc,
  body: unknown,
  caller: ReconCaller,
): Promise<Record<string, unknown>> {
  const userId = reconDecisionUser(caller);
  const { fn, args } = reconRecordDecisionCall(body, userId);
  const { data, error } = await client.rpc(fn, args);
  if (error) {
    const known = refusal(error);
    if (known) throw known;
    console.error("[recon_record_decision] write failed", error);
    throw new ReconDecisionError(
      "decision_not_recorded",
      502,
      "The decision was not recorded.",
    );
  }
  return { recorded: true, decision_id: data };
}
