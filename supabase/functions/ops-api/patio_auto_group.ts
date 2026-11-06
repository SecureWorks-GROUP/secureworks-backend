// WO-6 (job-profit INBOX, 2 Nov 2026): every patio job with 2+ crew gets a
// priced, approved work order and a group work order, measured weekly
// (public.v_patio_group_coverage).
//
// Two steps on the auto_issue_job_work_orders sweep (pg_cron, every 2
// minutes), both behind GROUP_WORK_ORDER_AUTO_PATIO_FLAG:
//   1. openMissingPatioWorkOrders, before the issue step: an open patio job
//      with 2+ crew and no job work order gets its draft (the trigger only
//      opens one when a job enters an open status, so jobs that were already
//      open had none). The issue step then fills it from the accepted quote's
//      labour and issues it, as for every other draft.
//   2. autoGroupPatioJobs, after the issue step: an open patio job with an
//      approved, sealed work order with labour, and 2+ crew, gets a group on
//      the full employer-super basis with every allocated crew member on it.
//      Pay comes from the work order's labour; nothing is frozen, invoiced,
//      sent or paid. A job already paid by hours is left alone (the
//      double-pay fence), and so is a job whose group is frozen or void.
// Crew = live allocations (no ghost, observer or cancelled row) of anyone who
// is not office admin. Never throws: every job comes back with a reason.
//
// V8 (job-profit INBOX, 3 Nov 2026): the same two steps for fencing jobs,
// behind their own flag GROUP_WORK_ORDER_AUTO_FENCE_FLAG, added off. The pay
// rule for fencing is the owner's G5 call ("on jobs with 2+ crew, pay the
// work order's labour as one group pool split by hours x rate, keep
// hours-only for solo"), not decided on 3 Nov, so nothing changes until he
// switches it on. The patio steps read only patio jobs and only the patio
// flag, whatever the fence flag says. One fence-only guard: a fence work order
// whose quote names priced labour outside the pool (a labour line flagged
// outside_quote_labour, e.g. SWF-261459: pool $0.35, $1,200 of labour outside
// it) gets no group by itself (labour_outside_pool); the office decides.
// A fence lead's fixed-price "work order" line is normal pay and blocks a
// group, as hours do (group_work_order_line_is_normal_pay).

import {
  assertNoNormalPayOnJob,
  GROUP_PAY_BASIS_EMPLOYER_SUPER,
  groupFeatureOn,
  GroupWorkOrderError,
  liveAssignment,
  newShareToken,
} from "./group_work_order.ts";
import { JOB_WORK_ORDER_OPEN_STATUSES } from "./job_work_order_quote_fill.ts";
import { QUOTE_LINE_FLAGS } from "./quote_work_order_lines.ts";

export const GROUP_WORK_ORDER_AUTO_PATIO_FLAG = "group_work_order_auto_patio_v1";
export const GROUP_WORK_ORDER_AUTO_FENCE_FLAG = "group_work_order_auto_fence_v1";
export const PATIO_AUTO_GROUP_MIN_CREW = 2;
/**
 * Owner, 3 Nov 2026: "all patio pay needs to go through [group work orders]
 * from now", one person or many, for patio jobs after Zoo. While this switch
 * is on a patio job needs 1 crew for its group, and ordinary hours on a patio
 * job are refused (group_work_order.ts assertPatioPaysThroughGroup).
 */
export const PATIO_PAY_GROUP_ONLY_FLAG = "patio_pay_group_only_v1";

async function minCrewFor(client: any, kind: { jobType: string }): Promise<number> {
  if (kind.jobType === "patio" && await flagOn(client, PATIO_PAY_GROUP_ONLY_FLAG)) return 1;
  return PATIO_AUTO_GROUP_MIN_CREW;
}

/** A patio on the pay-through-group rule gets its group as soon as the work order is priced, before anyone is allocated. Crew are added when they are named. */
async function minCrewToGroup(client: any, kind: { jobType: string }): Promise<number> {
  if (kind.jobType === "patio" && await flagOn(client, PATIO_PAY_GROUP_ONLY_FLAG)) return 0;
  return await minCrewFor(client, kind);
}
export const PATIO_AUTO_GROUP_LIMIT = 50;
/** Office admins are allocated to jobs to watch them, not to install. */
const NOT_CREW_ROLES: ReadonlySet<string> = new Set(["admin"]);

/** One job type the sweep can group, with its own switch. */
type AutoGroupKind = {
  jobType: "patio" | "fencing";
  flag: string;
  /** Refuse a group when the quote names priced labour outside the pool. */
  refuseLabourOutsidePool: boolean;
  logTag: string;
};

const PATIO: AutoGroupKind = {
  jobType: "patio",
  flag: GROUP_WORK_ORDER_AUTO_PATIO_FLAG,
  refuseLabourOutsidePool: false,
  logTag: "[patio-auto-group]",
};

const FENCE: AutoGroupKind = {
  jobType: "fencing",
  flag: GROUP_WORK_ORDER_AUTO_FENCE_FLAG,
  refuseLabourOutsidePool: true,
  logTag: "[fence-auto-group]",
};

export type PatioAutoGroupReason =
  | "group_created"
  | "crew_added"
  | "already_grouped"
  | "too_few_crew"
  | "crew_paid_by_hours_already"
  | "labour_outside_pool"
  | "group_frozen"
  | "group_void"
  | "group_failed";

export type PatioAutoGroupResult = {
  job_id: string;
  job_number: string | null;
  reason: PatioAutoGroupReason;
  group_id?: string | null;
  crew?: number;
  added?: number;
  code?: string;
};

async function flagOn(client: any, flag: string): Promise<boolean> {
  try {
    const { data, error } = await client.from("feature_flags").select("enabled")
      .eq("flag_name", flag).limit(1);
    if (error) return false;
    return data?.[0]?.enabled === true;
  } catch {
    return false;
  }
}

/**
 * V8: the work order's quote names priced labour its pool does not hold (a
 * line the quote fill flagged outside_quote_labour, with a total). A group
 * paid from that pool would leave the line's labour out. Mirror of
 * public.group_work_order_labour_outside_pool (20261103100000).
 */
export function labourOutsidePool(scopeItems: unknown): boolean {
  if (!Array.isArray(scopeItems)) return false;
  return scopeItems.some((item) => {
    if (!item || typeof item !== "object") return false;
    const flags = (item as Record<string, unknown>).flags;
    const total = (item as Record<string, unknown>).total;
    return Array.isArray(flags) &&
      flags.includes(QUOTE_LINE_FLAGS.outsideQuoteLabour) &&
      typeof total === "number" && total > 0;
  });
}

/** Distinct crew allocated to each job, by the live-allocation rule. */
export function crewByJob(
  assignments: readonly Record<string, unknown>[],
  roleByUser: ReadonlyMap<string, string>,
): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  for (const row of assignments) {
    if (!liveAssignment(row)) continue;
    const userId = String(row.user_id || "");
    const jobId = String(row.job_id || "");
    if (!userId || !jobId) continue;
    if (NOT_CREW_ROLES.has(String(roleByUser.get(userId) || "").toLowerCase())) {
      continue;
    }
    if (!out.has(jobId)) out.set(jobId, new Set());
    out.get(jobId)!.add(userId);
  }
  return new Map([...out].map(([job, set]) => [job, [...set].sort()]));
}

async function readCrew(client: any, jobIds: string[]) {
  if (jobIds.length === 0) return new Map<string, string[]>();
  const { data: rows, error } = await client.from("job_assignments").select(
    "job_id, user_id, status, role, is_ghost",
  ).in("job_id", jobIds);
  if (error) throw new Error("allocations unreadable");
  const assignments = Array.isArray(rows) ? rows : [];
  const userIds = [...new Set(assignments.map((r: any) => String(r.user_id || "")).filter(Boolean))];
  const roleByUser = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: users, error: usersError } = await client.from("users").select(
      "id, role",
    ).in("id", userIds);
    if (usersError) throw new Error("crew unreadable");
    for (const u of users || []) roleByUser.set(String(u.id), String(u.role || ""));
  }
  return crewByJob(assignments, roleByUser);
}

/** Step 1: open the missing draft for open patio jobs with 2+ crew. */
export function openMissingPatioWorkOrders(client: any) {
  return openMissingWorkOrders(client, PATIO);
}

/** V8 step 1 for fencing, behind group_work_order_auto_fence_v1 (added off). */
export function openMissingFenceWorkOrders(client: any) {
  return openMissingWorkOrders(client, FENCE);
}

/** Step 2: a group on every open patio job with a priced work order and 2+ crew. */
export function autoGroupPatioJobs(client: any) {
  return autoGroupJobs(client, PATIO);
}

/** V8 step 2 for fencing, behind group_work_order_auto_fence_v1 (added off). */
export function autoGroupFenceJobs(client: any) {
  return autoGroupJobs(client, FENCE);
}

async function openMissingWorkOrders(client: any, kind: AutoGroupKind) {
  if (!(await flagOn(client, kind.flag))) {
    return { switched_on: false, opened: 0, results: [] as unknown[] };
  }
  const results: { job_id: string; job_number: string | null; opened: boolean; code?: string }[] = [];
  try {
    const { data: jobs, error } = await client.from("jobs").select(
      "id, job_number, status, type",
    ).eq("type", kind.jobType).in("status", [...JOB_WORK_ORDER_OPEN_STATUSES]).limit(500);
    if (error) throw new Error("jobs unreadable");
    const ids = (jobs || []).map((j: any) => String(j.id));
    if (ids.length === 0) return { switched_on: true, opened: 0, results };
    const { data: wos, error: woError } = await client.from("work_orders").select(
      "job_id, status",
    ).eq("kind", "job").in("job_id", ids).in("status", ["draft", "approved"]);
    if (woError) throw new Error("work orders unreadable");
    const hasWo = new Set((wos || []).map((w: any) => String(w.job_id)));
    const missing = ids.filter((id: string) => !hasWo.has(id));
    const crew = await readCrew(client, missing);
    const minCrew = await minCrewFor(client, kind);
    for (const job of jobs || []) {
      const id = String(job.id);
      if (hasWo.has(id)) continue;
      if ((crew.get(id) || []).length < minCrew) continue;
      if (results.length >= PATIO_AUTO_GROUP_LIMIT) break;
      const { error: rpcError } = await client.rpc("ensure_job_work_order_draft", {
        p_job_id: id,
        p_origin: "backfill",
      });
      results.push({
        job_id: id,
        job_number: job.job_number ?? null,
        opened: !rpcError,
        ...(rpcError ? { code: String(rpcError.code || "open_failed") } : {}),
      });
    }
  } catch (e) {
    console.error(kind.logTag, "open drafts failed:", (e as Error)?.message);
  }
  return { switched_on: true, opened: results.filter((r) => r.opened).length, results };
}

async function autoGroupJobs(client: any, kind: AutoGroupKind) {
  const empty = { switched_on: false, created: 0, crew_added: 0, results: [] as PatioAutoGroupResult[] };
  if (!(await flagOn(client, kind.flag))) return empty;
  if (!(await groupFeatureOn(client))) return empty;
  const results: PatioAutoGroupResult[] = [];
  try {
    const { data: wos, error } = await client.from("work_orders").select(
      "id, job_id, agreed_labour_ex, sealed_content_hash, approved_by, scope_items, jobs:job_id!inner(id, org_id, job_number, type, status, work_order_id)",
    ).eq("kind", "job").eq("status", "approved").gt("agreed_labour_ex", 0)
      .not("sealed_content_hash", "is", null)
      .eq("jobs.type", kind.jobType).in("jobs.status", [...JOB_WORK_ORDER_OPEN_STATUSES])
      .limit(500);
    if (error) throw new Error("work orders unreadable");
    const live = (wos || []).filter((w: any) =>
      w.jobs && String(w.jobs.work_order_id || "") === String(w.id)
    );
    const jobIds = live.map((w: any) => String(w.job_id));
    if (jobIds.length === 0) return { ...empty, switched_on: true };
    const crew = await readCrew(client, jobIds);
    const minCrew = await minCrewToGroup(client, kind);
    const { data: groups, error: groupError } = await client.from("group_work_orders").select(
      "id, job_id, work_order_id, status, split_frozen_at",
    ).in("job_id", jobIds);
    if (groupError) throw new Error("groups unreadable");
    for (const wo of live) {
      if (results.length >= PATIO_AUTO_GROUP_LIMIT) break;
      const job = wo.jobs;
      const jobId = String(wo.job_id);
      const people = crew.get(jobId) || [];
      const base = { job_id: jobId, job_number: job.job_number ?? null, crew: people.length };
      const group = (groups || []).find((g: any) => String(g.job_id) === jobId);
      if (group) {
        const r = await topUpCrew(client, group, people, kind);
        if (r) results.push({ ...base, ...r });
        continue;
      }
      if (people.length < minCrew) continue;
      if (kind.refuseLabourOutsidePool && labourOutsidePool(wo.scope_items)) {
        results.push({ ...base, reason: "labour_outside_pool" });
        continue;
      }
      try {
        await assertNoNormalPayOnJob(client, jobId);
      } catch (e) {
        results.push({
          ...base,
          reason: "crew_paid_by_hours_already",
          code: e instanceof GroupWorkOrderError ? e.code : "pay_unreadable",
        });
        continue;
      }
      const { data: created, error: insertError } = await client.from("group_work_orders").insert({
        org_id: job.org_id,
        job_id: jobId,
        work_order_id: String(wo.id),
        status: "open",
        pay_basis: GROUP_PAY_BASIS_EMPLOYER_SUPER,
        share_token: newShareToken(),
        created_by: wo.approved_by ?? null,
      }).select("id").single();
      if (insertError) {
        const blocked = String(insertError.message || "").includes("group_open_blocked_by_work_order_claim");
        results.push({
          ...base,
          reason: blocked ? "crew_paid_by_hours_already" : String(insertError.code) === "23505" ? "already_grouped" : "group_failed",
          code: String(insertError.code || ""),
        });
        continue;
      }
      const groupId = String(created.id);
      let crewError: { message?: string } | null = null;
      if (people.length) {
        const added = await client.from("group_work_order_participants").insert(
          people.map((userId) => ({ group_id: groupId, user_id: userId })),
        );
        crewError = added.error;
      }
      if (crewError) console.error(kind.logTag, "crew not added:", groupId, crewError.message);
      await logEvent(client, jobId, "group_work_order_auto_created", {
        group_id: groupId,
        work_order_id: String(wo.id),
        crew: people.length,
      }, kind);
      results.push({ ...base, reason: "group_created", group_id: groupId, added: crewError ? 0 : people.length });
    }
  } catch (e) {
    console.error(kind.logTag, "sweep failed:", (e as Error)?.message);
  }
  return {
    switched_on: true,
    created: results.filter((r) => r.reason === "group_created").length,
    crew_added: results.filter((r) => r.reason === "crew_added").length,
    results,
  };
}

/** People a group's remove_participant events took off it (left or removed). */
export function removedUserIds(rows: readonly Record<string, unknown>[]): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    const detail = row.detail && typeof row.detail === "object" ? row.detail as Record<string, unknown> : {};
    const id = String(detail.user_id || "");
    if (id) out.add(id);
  }
  return out;
}

/**
 * Crew allocated after the group opened join it, until its pay is frozen,
 * unless they left it or the office removed them.
 */
async function topUpCrew(
  client: any,
  group: Record<string, unknown>,
  people: string[],
  kind: AutoGroupKind,
): Promise<Pick<PatioAutoGroupResult, "reason" | "group_id" | "added" | "code"> | null> {
  const groupId = String(group.id);
  if (group.status === "void") return null;
  if (group.split_frozen_at) return null;
  const { data: on, error } = await client.from("group_work_order_participants").select(
    "user_id",
  ).eq("group_id", groupId);
  if (error) return { reason: "group_failed", group_id: groupId, code: "crew_unreadable" };
  const have = new Set((on || []).map((r: any) => String(r.user_id)));
  // Someone who left, or whom the office removed, stays off (owner, 6 Nov
  // 2026: trades opt in themselves). They can join again on their own.
  const { data: removals, error: removalError } = await client.from("group_work_order_events").select(
    "detail",
  ).eq("group_id", groupId).eq("action", "remove_participant");
  if (removalError) return { reason: "group_failed", group_id: groupId, code: "removals_unreadable" };
  const leftCrew = removedUserIds(removals || []);
  const add = people.filter((id) => !have.has(id) && !leftCrew.has(id));
  if (add.length === 0) return null;
  const { error: addError } = await client.from("group_work_order_participants").insert(
    add.map((userId) => ({ group_id: groupId, user_id: userId })),
  );
  if (addError) return { reason: "group_failed", group_id: groupId, code: String(addError.code || "") };
  await logEvent(client, String(group.job_id), "group_work_order_auto_crew_added", {
    group_id: groupId,
    added: add.length,
  }, kind);
  return { reason: "crew_added", group_id: groupId, added: add.length };
}

async function logEvent(
  client: any,
  jobId: string,
  eventType: string,
  detail: Record<string, unknown>,
  kind: AutoGroupKind,
) {
  try {
    const { error } = await client.from("job_events").insert({
      job_id: jobId,
      event_type: eventType,
      user_id: null,
      detail_json: detail,
    });
    if (error) console.error(kind.logTag, "event not logged:", eventType, error.message);
  } catch (e) {
    console.error(kind.logTag, "event not logged:", eventType, (e as Error)?.message);
  }
}
