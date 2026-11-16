// deno-lint-ignore-file no-explicit-any
// Ruling 17 step 4 (backend half): how the crew is paid comes from the job
// budget, and a job paid hourly up to a maximum holds every trade to it.
//
// Ruling 17c (16 Nov 2026): one labour cap per job, through one guard. The
// refusal is the live work order cap's (_assertWithinWorkOrderTotal,
// work_order_total_cap.ts): same doors, same count, same codes. This module
// only supplies what that guard needs for an hourly job: which jobs are paid
// hourly up to a maximum, and each one's limit, read from the database's one
// read job_labour_cap_state (20261114030000_job_labour_cap.sql): what the
// work order promises the crew (ruling 18 B: the budget's work order amount,
// which is the sealed maximum, plus any crew option the customer took, plus
// every line in another lane paid to the crew, a removal for one) plus the
// approver's raises. raise_job_labour_cap is the only writer of a raise (an approver
// owner_approval_authority already names). Also here: the switch, the pay
// mode the invoice mode reads and the staff read and raise doors.
//
// Contract: docs/job-budget-v1.md, "Labour: pay mode and the hourly cap (step 4)".

/** What is already billed on each job, by the guard's one count
 *  (readBilledOnJobs, work_order_total_cap.ts; passed in by index.ts, which
 *  keeps this module free of an import cycle through the work order fill). */
export type ReadBilledOnJobs = (
  client: any,
  jobIds: readonly string[],
) => Promise<ReadonlyMap<string, number>>;

export const JOB_LABOUR_BUDGET_FLAG = "job_labour_budget_v1";

export type JobLabourPay = "group_work_order" | "hourly_capped";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class JobLabourCapError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class JobLabourPayReadError extends Error {}

/** The switch. A missing row, or anything but true, is off. A read that
 *  fails is never off: it throws JobLabourPayReadError, so a cap is never
 *  dropped on a fault. */
export async function readJobLabourBudgetOn(client: any): Promise<boolean> {
  let res: any;
  try {
    // flag_name is the table's key, so this is one row or none.
    res = await client.from("feature_flags").select("enabled")
      .eq("flag_name", JOB_LABOUR_BUDGET_FLAG);
  } catch {
    throw new JobLabourPayReadError("the labour budget switch");
  }
  if (res?.error) throw new JobLabourPayReadError("the labour budget switch");
  return res?.data?.[0]?.enabled === true;
}

/** The pay mode a stored budget names, or null. Pure. */
export function budgetLabourPay(budget: unknown): JobLabourPay | null {
  const pay = (budget as any)?.labour?.pay;
  return pay === "group_work_order" || pay === "hourly_capped" ? pay : null;
}

/** What the job work order's agreed labour is, from the budget: the work
 *  order amount (labour plus every crew-paid line in other lanes; on hourly
 *  pay the labour is the maximum). null when the budget has none. Pure. */
export function budgetAgreedLabour(budget: unknown): number | null {
  const raw = (budget as any)?.labour?.work_order_amount_ex_gst;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0
    ? Math.round(raw * 100) / 100
    : null;
}

/**
 * The jobs whose newest stored budget pays the crew hourly up to a maximum.
 * Empty while the switch is off. Throws JobLabourPayReadError when the
 * switch or the budgets cannot be read, whether the read returns an error or
 * throws, so a job is never invoiced past its cap on a fault and the guard
 * answers 503, never a bare error.
 */
export async function readHourlyCappedJobs(
  client: any,
  jobIds: readonly string[],
): Promise<Set<string>> {
  const capped = new Set<string>();
  const ids = [...new Set(jobIds.filter((id) => UUID_RE.test(String(id))))];
  if (ids.length === 0) return capped;
  if (!(await readJobLabourBudgetOn(client))) return capped;
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50);
    let res: any;
    try {
      res = await client.from("job_budgets")
        .select("job_id, version, pay:budget->labour->>pay")
        .in("job_id", part);
    } catch {
      throw new JobLabourPayReadError("the job budgets");
    }
    if (!res || res.error) throw new JobLabourPayReadError("the job budgets");
    const data = res.data;
    const newest = new Map<string, { version: number; pay: unknown }>();
    for (const row of data || []) {
      const jobId = String(row?.job_id || "");
      const version = Number(row?.version);
      if (!jobId || !Number.isFinite(version)) continue;
      const seen = newest.get(jobId);
      if (!seen || version > seen.version) newest.set(jobId, { version, pay: row?.pay });
    }
    for (const [jobId, b] of newest) if (b.pay === "hourly_capped") capped.add(jobId);
  }
  return capped;
}

export type NewestJobBudgetLabour =
  | { state: "off" | "none" | "unreadable" }
  | {
    state: "found";
    budget_id: string;
    scope_revision_id: string;
    pay: JobLabourPay | null;
    work_order_amount_ex_gst: number | null;
  };

/** The newest stored budget's labour for one job, while the switch is on.
 *  "unreadable" on any read fault: the caller holds rather than guesses. */
export async function readNewestJobBudgetLabour(client: any, jobId: string): Promise<NewestJobBudgetLabour> {
  if (!UUID_RE.test(String(jobId))) return { state: "none" };
  try {
    if (!(await readJobLabourBudgetOn(client))) return { state: "off" };
    const { data, error } = await client.from("job_budgets")
      .select("id, scope_revision_id, version, labour:budget->labour")
      .eq("job_id", jobId)
      .order("version", { ascending: false })
      .limit(1);
    if (error) return { state: "unreadable" };
    const row = Array.isArray(data) ? data[0] : null;
    if (!row) return { state: "none" };
    if (!row.id || !row.scope_revision_id) return { state: "unreadable" };
    const budget = { labour: row.labour };
    return {
      state: "found",
      budget_id: String(row.id),
      scope_revision_id: String(row.scope_revision_id),
      pay: budgetLabourPay(budget),
      work_order_amount_ex_gst: budgetAgreedLabour(budget),
    };
  } catch {
    return { state: "unreadable" };
  }
}

/** Pure. The limit a capped state carries, or null when it is not a capped
 *  state with a whole, non-negative cap. */
export function hourlyLimitFromState(state: unknown): number | null {
  const s = state as any;
  if (!s || typeof s !== "object" || s.state !== "capped") return null;
  const cap = s.cap_ex_gst;
  return typeof cap === "number" && Number.isFinite(cap) && cap >= 0
    ? Math.round(cap * 100) / 100
    : null;
}

/**
 * Ruling 17c: the limit of every job among `jobIds` paid hourly up to a
 * maximum (absent for any other job), for the one cap guard. Throws
 * JobLabourPayReadError when the switch, the budgets or a job's state cannot
 * be read, and when a capped job's maximum cannot be read
 * (capped_unreadable): the guard refuses, never lets labour through.
 */
export async function readHourlyLabourLimits(
  client: any,
  jobIds: readonly string[],
): Promise<Map<string, number>> {
  const capped = [...await readHourlyCappedJobs(client, jobIds)];
  const limits = new Map<string, number>();
  const states = await Promise.all(capped.map(async (jobId) => {
    try {
      const { data, error } = await client.rpc("job_labour_cap_state", { p_job: jobId });
      return error ? null : data;
    } catch {
      return null;
    }
  }));
  capped.forEach((jobId, i) => {
    const limit = hourlyLimitFromState(states[i]);
    if (limit === null) throw new JobLabourPayReadError("a job's labour maximum");
    limits.set(jobId, limit);
  });
  return limits;
}

/** The job's cap for the office: the database's limit read
 *  (job_labour_cap_state) and what is already billed on the job by the one
 *  count the guard refuses by (readBilledOnJobs). Staff only. */
export async function readJobLabourCap(
  client: any,
  jobId: string,
  readBilled: ReadBilledOnJobs,
): Promise<any> {
  const unreadable = () =>
    new JobLabourCapError(503, "labour_cap_unreadable", "The job's labour maximum could not be read. Try again in a minute.");
  let res: any;
  try {
    res = await client.rpc("job_labour_cap_state", { p_job: jobId });
  } catch {
    throw unreadable();
  }
  const data = res?.data;
  if (!res || res.error || !data || typeof data !== "object") throw unreadable();
  if (data.state !== "capped" && data.state !== "capped_unreadable") return data;
  let billed: number;
  try {
    billed = (await readBilled(client, [jobId])).get(jobId) ?? 0;
  } catch {
    throw unreadable();
  }
  const cap = typeof data.cap_ex_gst === "number" ? data.cap_ex_gst : 0;
  return {
    ...data,
    billed_ex_gst: billed,
    remaining_ex_gst: Math.round((cap - billed) * 100) / 100,
  };
}

const RAISE_REFUSALS: Array<[string, number, string, string]> = [
  ["job_labour_cap_not_approver", 403, "not_approver", "Only a work order approver can raise a job's labour maximum."],
  ["job_labour_cap_wrong_company", 403, "wrong_company", "That job is not in your company."],
  ["job_labour_cap_job_not_found", 404, "job_not_found", "That job was not found."],
  ["job_labour_cap_no_budget", 409, "no_budget", "This job has no stored budget, so it has no labour maximum to raise."],
  ["job_labour_cap_budget_changed", 409, "budget_changed", "The job's budget changed since you looked. Reload it and raise the new maximum."],
  ["job_labour_cap_not_hourly", 409, "not_hourly", "This job is paid as a group work order, so it has no hourly maximum to raise."],
  ["job_labour_cap_amount_invalid", 400, "amount_invalid", "Give the raise in dollars ex GST, above zero, two decimals at most."],
  ["job_labour_cap_reason_invalid", 400, "reason_invalid", "Give a reason of 3 to 500 characters."],
];

/** Raise a job's labour maximum: the approver's own signed-in act. */
export async function raiseJobLabourCapAction(
  client: any,
  body: any,
  actor: { userId: string | null; email: string | null; orgId: string | null },
): Promise<any> {
  if (!actor.userId) {
    throw new JobLabourCapError(403, "named_person_required", "A raise is given by a signed-in approver, so it names who gave it.");
  }
  const jobId = String(body?.job_id || "").trim();
  const budgetId = String(body?.budget_id || "").trim();
  if (!UUID_RE.test(jobId)) throw new JobLabourCapError(400, "invalid_request", "job_id must be a uuid");
  if (!UUID_RE.test(budgetId)) throw new JobLabourCapError(400, "invalid_request", "budget_id must be the budget you were shown");
  const amount = body?.amount_ex_gst;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 ||
      Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) {
    throw new JobLabourCapError(400, "amount_invalid", "Give the raise in dollars ex GST, above zero, two decimals at most.");
  }
  const reason = typeof body?.reason === "string" ? body.reason.replace(/\s+/g, " ").trim() : "";
  if (reason.length < 3 || reason.length > 500) {
    throw new JobLabourCapError(400, "reason_invalid", "Give a reason of 3 to 500 characters.");
  }
  const { data, error } = await client.rpc("raise_job_labour_cap", {
    p_job: jobId,
    p_budget_id: budgetId,
    p_actor: actor.userId,
    p_actor_email: actor.email,
    p_org_id: actor.orgId,
    p_amount: Math.round(amount * 100) / 100,
    p_reason: reason,
  });
  if (error) {
    const message = String(error?.message || "");
    for (const [needle, status, code, words] of RAISE_REFUSALS) {
      if (message.includes(needle)) throw new JobLabourCapError(status, code, words);
    }
    throw new JobLabourCapError(503, "labour_cap_unwritable", "The raise could not be recorded. Try again in a minute.");
  }
  return data;
}

/**
 * The staff doors. GET job_labour_cap?job_id= reads a job's cap (staff in the
 * job's company, or the server key). POST raise_job_labour_cap records a
 * raise, only from a signed-in person; who may raise is the database's
 * owner_approval_authority (the work order approver list, not touched here).
 */
export async function jobLabourCapAction(
  client: any,
  action: "job_labour_cap" | "raise_job_labour_cap",
  method: string,
  input: any,
  ctx: { staff: boolean; signedIn: boolean; orgId: string | null; userId: string | null; email: string | null },
  readBilled: ReadBilledOnJobs,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const refuse = (status: number, code: string, error: string) => ({ status, body: { ok: false, code, error } });
  try {
    if (action === "job_labour_cap") {
      if (method !== "GET") return refuse(405, "method_not_allowed", "Use GET.");
      if (!ctx.staff || !ctx.orgId) return refuse(403, "operator_access_required", "Office staff only.");
      const jobId = String(input?.job_id || "").trim();
      if (!UUID_RE.test(jobId)) return refuse(400, "invalid_request", "job_id must be a uuid");
      const { data: job, error } = await client.from("jobs").select("id")
        .eq("id", jobId).eq("org_id", ctx.orgId).maybeSingle();
      if (error) return refuse(503, "labour_cap_unreadable", "The job's labour maximum could not be read. Try again in a minute.");
      if (!job) return refuse(404, "job_not_found", "That job was not found.");
      return { status: 200, body: { ok: true, cap: await readJobLabourCap(client, jobId, readBilled) } };
    }
    if (method !== "POST") return refuse(405, "method_not_allowed", "Use POST.");
    if (!ctx.signedIn || !ctx.userId) {
      return refuse(403, "named_person_required", "A raise is given by a signed-in approver, so it names who gave it.");
    }
    const raised = await raiseJobLabourCapAction(client, input, {
      userId: ctx.userId,
      email: ctx.email,
      orgId: ctx.orgId,
    });
    return { status: 200, body: { ok: true, ...raised } };
  } catch (error) {
    if (error instanceof JobLabourCapError) return refuse(error.status, error.code, error.message);
    throw error;
  }
}
