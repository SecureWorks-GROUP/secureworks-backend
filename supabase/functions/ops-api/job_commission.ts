// Ruling 17 step 2: the commission rule, the job's commission record and the
// cap (contract: docs/job-budget-v1.md, "Commission (step 2)").
//
// The rate is the app's: one per trade (fence 15, patio 8, of the budget's
// gross profit), in commission_rates, read by staff and changed only by an
// editor named in commission_rate_settings (set_commission_rate). The scoping
// tool works the commission at seal from that rate; the job system copies it
// into job_commissions when the budget is stored (a trigger on job_budgets).
//
// The cap: on a job with a commission record, a commission line is accepted
// only from the named salesperson and only while the job's counted commission
// stays within the record's expected amount. The database holds every write
// path to that (20261113230000_job_commissions.sql); this module checks the
// same rule before the invoice route writes anything, so the trade gets a
// plain refusal instead of a failed save. A job with no record keeps today's
// rules.
//
// Refusals carry codes and job numbers, never money: a trade reads them.
//
// Doors (ops-api):
//   commission_rates     GET   staff or server key: the current rate per trade
//   set_commission_rate  POST  the signed-in owner only: {trade, percent, reason}
//   job_commission       GET   staff or server key: one job's record, what
//                              counts against it and what is left
//                              (the AI command, "commission show")
// deno-lint-ignore-file no-explicit-any

export type JobCommissionRecord = {
  job_id: string;
  commission_id: string;
  budget_id: string;
  version: number;
  state: "named" | "no_salesperson" | "salesperson_not_found" | "no_amount";
  salesperson_user_id: string | null;
  rule_id: string | null;
  percent: number | null;
  expected_amount_ex_gst: number | null;
  claimed_ex_gst: number;
  remaining_ex_gst: number | null;
};

export class JobCommissionReadError extends Error {
  constructor(what: string) {
    super(`Could not read ${what}`);
  }
}

const CHUNK = 25;
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const cents = (v: number) => Math.round(v * 100);

function toRecord(row: any): JobCommissionRecord {
  return {
    job_id: String(row.job_id),
    commission_id: String(row.commission_id),
    budget_id: String(row.budget_id),
    version: Number(row.version),
    state: row.state,
    salesperson_user_id: row.salesperson_user_id ? String(row.salesperson_user_id) : null,
    rule_id: row.rule_id ?? null,
    percent: num(row.percent),
    expected_amount_ex_gst: num(row.expected_amount_ex_gst),
    claimed_ex_gst: num(row.claimed_ex_gst) ?? 0,
    remaining_ex_gst: num(row.remaining_ex_gst),
  };
}

/**
 * The current commission record of each job that has one. A job missing from
 * the map has no record (today's rules). Throws on a failed read: a cap that
 * cannot be read never passes as "no record".
 */
export async function readJobCommissionRecords(
  client: any,
  jobIds: readonly string[],
): Promise<Map<string, JobCommissionRecord>> {
  const ids = [...new Set(jobIds.map((id) => String(id || "").trim()).filter(Boolean))];
  const out = new Map<string, JobCommissionRecord>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await client.from("v_job_commission")
      .select(
        "job_id, commission_id, budget_id, version, state, salesperson_user_id, rule_id, percent, expected_amount_ex_gst, claimed_ex_gst, remaining_ex_gst",
      )
      .in("job_id", ids.slice(i, i + CHUNK));
    if (error) {
      // Before the migration is applied there are no records: today's rules.
      if (isMissingRelation(error)) return new Map();
      throw new JobCommissionReadError("the job commission records");
    }
    for (const row of data || []) {
      if (row?.job_id) out.set(String(row.job_id), toRecord(row));
    }
  }
  return out;
}

function isMissingRelation(error: any): boolean {
  const code = String(error?.code ?? "");
  return code === "42P01" || code === "PGRST205" || code === "PGRST200";
}

export type CommissionClaimLine = { jobId: string; ref: string; amountEx: number };

export type CommissionCapRefusalCode =
  | "commission_not_salesperson"
  | "commission_amount_unknown"
  | "commission_over_amount";

export type CommissionCapRefusal = {
  code: CommissionCapRefusalCode;
  jobs: string[];
  message: string;
};

function jobList(refs: string[]): string {
  return refs.length === 1 ? `job ${refs[0]}` : `jobs ${refs.join(", ")}`;
}

/**
 * The cap, for the commission lines of one submission (pure). Each job with a
 * record: the trade must be its named salesperson, the record must carry an
 * amount, and what already counts plus this submission's lines must not pass
 * it. The first failing rule (in that order) names every job it fails on.
 */
export function commissionCapRefusal(input: {
  tradeId: string;
  lines: readonly CommissionClaimLine[];
  records: ReadonlyMap<string, JobCommissionRecord>;
}): CommissionCapRefusal | null {
  const byJob = new Map<string, { ref: string; cents: number }>();
  for (const line of input.lines) {
    if (!input.records.has(line.jobId)) continue;
    const prev = byJob.get(line.jobId);
    byJob.set(line.jobId, {
      ref: prev?.ref ?? line.ref,
      cents: (prev?.cents ?? 0) + cents(Number(line.amountEx) || 0),
    });
  }
  const notSalesperson: string[] = [];
  const unknown: string[] = [];
  const over: string[] = [];
  for (const [jobId, claim] of byJob) {
    const rec = input.records.get(jobId)!;
    if (!rec.salesperson_user_id || rec.salesperson_user_id !== input.tradeId) {
      notSalesperson.push(claim.ref);
    } else if (rec.state !== "named" || rec.expected_amount_ex_gst === null) {
      unknown.push(claim.ref);
    } else if (cents(rec.claimed_ex_gst) + claim.cents > cents(rec.expected_amount_ex_gst)) {
      over.push(claim.ref);
    }
  }
  if (notSalesperson.length > 0) {
    return {
      code: "commission_not_salesperson",
      jobs: notSalesperson,
      message: `This invoice was not saved. Commission on ${jobList(notSalesperson)} can only be claimed by the salesperson named on its accepted quote. Take the commission line off, or ask the office.`,
    };
  }
  if (unknown.length > 0) {
    return {
      code: "commission_amount_unknown",
      jobs: unknown,
      message: `This invoice was not saved. The accepted quote for ${jobList(unknown)} has no commission figure, so no commission can be claimed on it yet. Ask the office.`,
    };
  }
  if (over.length > 0) {
    return {
      code: "commission_over_amount",
      jobs: over,
      message: `This invoice was not saved. The commission on ${jobList(over)} is more than its accepted quote allows (counting commission already claimed). Lower the commission line, or ask the office.`,
    };
  }
  return null;
}

/** The database's own cap refusals, read off a failed write. */
export function commissionCapCodeFromDbError(error: unknown): CommissionCapRefusalCode | null {
  const text = String((error as any)?.message ?? error ?? "");
  for (const code of ["commission_not_salesperson", "commission_amount_unknown", "commission_over_amount"] as const) {
    if (text.includes(code)) return code;
  }
  return null;
}

// ─── Doors ──────────────────────────────────────────────────────────────────

export type JobCommissionActor = {
  /** Staff sign-in or the server key (_opsApiCallerIsStaffOperator). */
  staff: boolean;
  /** The signed-in user's id when the caller is a staff sign-in, else null. */
  sessionUserId: string | null;
  orgId: string | null;
};

const reply = (status: number, body: Record<string, unknown>) => ({ status, body });

export async function jobCommissionAction(
  client: any,
  action: string,
  method: string,
  params: Record<string, unknown>,
  actor: JobCommissionActor,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!actor.staff) return reply(403, { code: "operator_access_required" });

  if (action === "commission_rates") {
    const { data, error } = await client.from("v_commission_rates")
      .select("trade, rule_id, percent, basis, set_at")
      .order("trade");
    if (error) return reply(503, { code: "commission_rates_unavailable" });
    return reply(200, { rates: (data || []).map((r: any) => ({ ...r, percent: num(r.percent) })) });
  }

  if (action === "set_commission_rate") {
    if (method !== "POST") return reply(405, { code: "post_required" });
    // Only a person's own sign-in: never the server key, never a named actor.
    if (!actor.sessionUserId) return reply(403, { code: "commission_rate_editor_only" });
    const trade = String(params.trade ?? "").trim().toLowerCase();
    const percent = num(params.percent);
    const reason = typeof params.reason === "string" ? params.reason.trim() : "";
    if (trade !== "fence" && trade !== "patio") return reply(400, { code: "commission_rate_trade_unknown" });
    if (percent === null || percent < 0 || percent > 100 || Math.abs(Math.round(percent * 100) - percent * 100) > 1e-6) {
      return reply(400, { code: "commission_rate_percent_invalid" });
    }
    if (!reason) return reply(400, { code: "commission_rate_reason_required" });
    const { data, error } = await client.rpc("set_commission_rate", {
      p_trade: trade,
      p_percent: percent,
      p_reason: reason,
      p_actor: actor.sessionUserId,
    });
    if (error) {
      const text = String(error?.message ?? "");
      if (text.includes("commission_rate_editor_only")) return reply(403, { code: "commission_rate_editor_only" });
      for (const code of ["commission_rate_trade_unknown", "commission_rate_percent_invalid", "commission_rate_reason_required"]) {
        if (text.includes(code)) return reply(400, { code });
      }
      return reply(503, { code: "commission_rate_not_saved" });
    }
    return reply(200, { saved: true, rate: data });
  }

  if (action === "job_commission") {
    const jobId = String(params.job_id ?? "").trim();
    if (!jobId) return reply(400, { code: "job_id_required" });
    if (actor.orgId) {
      const owned = await client.from("jobs").select("id").eq("id", jobId).eq("org_id", actor.orgId).maybeSingle();
      if (owned.error) return reply(503, { code: "job_commission_unavailable" });
      if (!owned.data) return reply(404, { code: "job_not_found" });
    }
    let records: Map<string, JobCommissionRecord>;
    try {
      records = await readJobCommissionRecords(client, [jobId]);
    } catch {
      return reply(503, { code: "job_commission_unavailable" });
    }
    const record = records.get(jobId) ?? null;
    if (!record) return reply(200, { job_id: jobId, commission: null, state: "no_record" });
    let salesperson: { id: string; name: string | null } | null = null;
    if (record.salesperson_user_id) {
      const person = await client.from("users").select("id, name").eq("id", record.salesperson_user_id).maybeSingle();
      salesperson = { id: record.salesperson_user_id, name: person.data?.name ?? null };
    }
    return reply(200, { job_id: jobId, commission: { ...record, salesperson }, state: record.state });
  }

  return reply(400, { code: "unknown_action" });
}
