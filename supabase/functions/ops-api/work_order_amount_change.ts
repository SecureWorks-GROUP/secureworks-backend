// deno-lint-ignore-file no-explicit-any
// P1-14. The sealed work order remains unchanged.
type Caller = {
  staff: boolean;
  // A signed-in staff person's own id; null for every other caller.
  userId: string | null;
  orgId: string | null;
  // True only for the server key presented with a server secret (the ops
  // agent). Such a caller names the staff person it acts for in
  // body.actor_user_id; that person must be office staff in the company.
  serverKey?: boolean;
};
const STAFF_ROLES = new Set(["admin", "owner", "ops_manager"]);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const refusal = (status: number, code: string, error: string) => ({
  status,
  body: { code, error },
});
const messages: Record<string, string> = {
  work_order_split_locked:
    "The crew's split on this job is locked. Unlock it first, then change the amount.",
  work_order_change_below_billed:
    "That is less than has already been invoiced on this job.",
  work_order_not_approved:
    "This work order is still a draft. Change the amount in the draft.",
  work_order_not_found: "The work order could not be found.",
  work_order_wrong_company: "The work order belongs to another company.",
  work_order_change_reason_required: "Give a reason for this change.",
  work_order_change_amount_invalid:
    "Enter a non-negative amount in dollars and cents.",
};
export async function workOrderAmountChangeAction(
  client: any,
  action: string,
  method: string,
  body: Record<string, any>,
  caller: Caller,
) {
  if (!caller.staff) {
    return refusal(403, "staff_only", "Only staff can change work orders.");
  }
  const listing = action === "work_order_changes";
  if (method !== (listing ? "GET" : "POST")) {
    return refusal(
      405,
      "method_not_allowed",
      "Use the required request method.",
    );
  }
  if (!caller.orgId) {
    return refusal(403, "staff_only", "A company is required.");
  }
  if (listing) {
    const limit = body.limit == null ? 50 : Number(body.limit);
    if (
      !Number.isInteger(limit) || limit < 1 || limit > 200 ||
      (body.before && !Number.isFinite(Date.parse(body.before)))
    ) {
      return refusal(
        400,
        "work_order_changes_invalid",
        "Check the limit and before date.",
      );
    }
    let query = client.from("work_order_amount_changes").select(
      "id, changed_at, work_order_id, kind, from_ex, to_ex, reason, detail, profit_before_ex, profit_after_ex, profit_basis, actor:users!changed_by(name), job:jobs!job_id(job_number)",
    )
      .eq("org_id", caller.orgId).order("changed_at", { ascending: false })
      .order("id", { ascending: false }).limit(limit);
    if (body.before) query = query.lt("changed_at", body.before);
    const read = await query;
    if (read.error) throw new Error("Could not read work order changes");
    return {
      status: 200,
      body: {
        changes: (read.data || []).map(({ actor, job, ...row }: any) => ({
          ...row,
          changed_by_name: actor?.name ?? null,
          job_number: job?.job_number ?? null,
        })),
      },
    };
  }
  // Who changes it: the signed-in staff person, or (server key only) the
  // staff person the agent names. A trade's session never reaches here
  // (caller.staff is false) and a staff session cannot name someone else.
  let actorUserId = caller.userId;
  if (
    !actorUserId && caller.serverKey === true &&
    body.actor_user_id !== undefined && body.actor_user_id !== null
  ) {
    const named = String(body.actor_user_id).trim();
    if (!UUID.test(named)) {
      return refusal(
        403,
        "named_person_required",
        "Name the staff person this change is for (actor_user_id).",
      );
    }
    const person = await client.from("users").select("id, org_id, role").eq(
      "id",
      named,
    ).maybeSingle();
    if (person.error) {
      throw new Error("Could not check the named staff person");
    }
    if (
      !person.data?.id || String(person.data.org_id) !== String(caller.orgId) ||
      !STAFF_ROLES.has(String(person.data.role || "").trim().toLowerCase())
    ) {
      return refusal(
        403,
        "actor_not_staff",
        "The named person is not office staff in this company.",
      );
    }
    actorUserId = String(person.data.id);
  }
  if (!actorUserId) {
    return refusal(
      403,
      "named_person_required",
      "Sign in as a staff member to change the amount.",
    );
  }
  if (typeof body.reason !== "string" || body.reason.trim().length < 3) {
    return refusal(
      400,
      "work_order_change_reason_required",
      messages.work_order_change_reason_required,
    );
  }
  const flag = await client.from("feature_flags").select("enabled").eq(
    "flag_name",
    "work_order_amount_change_v1",
  ).maybeSingle();
  if (flag.error || flag.data?.enabled !== true) {
    return refusal(
      409,
      "work_order_change_switch_off",
      "Work order amount changes are switched off.",
    );
  }
  const read = await client.rpc("change_work_order_amount", {
    p_work_order_id: body.work_order_id,
    p_to_ex: body.to_ex,
    p_reason: body.reason.trim(),
    p_actor: actorUserId,
    p_org_id: caller.orgId,
  });
  if (read.error) {
    const code = Object.keys(messages).find((key) =>
      String(read.error.message).includes(key)
    );
    if (!code) throw new Error("Could not change work order amount");
    return refusal(409, code, messages[code]);
  }
  return { status: 200, body: { change: read.data } };
}

export async function recordWorkOrderPeopleChange(client: any, input: {
  orgId: unknown;
  workOrderId: unknown;
  jobId: unknown;
  actorUserId: unknown;
  reason: string;
  detail: { action: "add" | "leave" | "remove" | "restore"; count?: number };
}): Promise<void> {
  try {
    const { error } = await client.from("work_order_amount_changes").insert({
      org_id: input.orgId,
      work_order_id: input.workOrderId,
      job_id: input.jobId,
      changed_by: input.actorUserId,
      kind: "people",
      delta_ex: 0,
      from_ex: null,
      to_ex: null,
      reason: input.reason,
      detail: {
        action: input.detail.action,
        ...(input.detail.count === undefined
          ? {}
          : { count: input.detail.count }),
      },
    });
    if (error) throw error;
  } catch {
    console.error("[ops-api] work order people change could not be recorded");
  }
}
