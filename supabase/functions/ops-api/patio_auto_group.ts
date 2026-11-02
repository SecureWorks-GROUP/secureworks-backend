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

import {
  assertNoNormalPayOnJob,
  GROUP_PAY_BASIS_EMPLOYER_SUPER,
  groupFeatureOn,
  GroupWorkOrderError,
  liveAssignment,
  newShareToken,
} from "./group_work_order.ts";
import { JOB_WORK_ORDER_OPEN_STATUSES } from "./job_work_order_quote_fill.ts";

export const GROUP_WORK_ORDER_AUTO_PATIO_FLAG = "group_work_order_auto_patio_v1";
export const PATIO_AUTO_GROUP_MIN_CREW = 2;
export const PATIO_AUTO_GROUP_LIMIT = 50;
/** Office admins are allocated to jobs to watch them, not to install. */
const NOT_CREW_ROLES: ReadonlySet<string> = new Set(["admin"]);

export type PatioAutoGroupReason =
  | "group_created"
  | "crew_added"
  | "already_grouped"
  | "too_few_crew"
  | "crew_paid_by_hours_already"
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
export async function openMissingPatioWorkOrders(client: any) {
  if (!(await flagOn(client, GROUP_WORK_ORDER_AUTO_PATIO_FLAG))) {
    return { switched_on: false, opened: 0, results: [] as unknown[] };
  }
  const results: { job_id: string; job_number: string | null; opened: boolean; code?: string }[] = [];
  try {
    const { data: jobs, error } = await client.from("jobs").select(
      "id, job_number, status, type",
    ).eq("type", "patio").in("status", [...JOB_WORK_ORDER_OPEN_STATUSES]).limit(500);
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
    for (const job of jobs || []) {
      const id = String(job.id);
      if (hasWo.has(id)) continue;
      if ((crew.get(id) || []).length < PATIO_AUTO_GROUP_MIN_CREW) continue;
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
    console.error("[patio-auto-group] open drafts failed:", (e as Error)?.message);
  }
  return { switched_on: true, opened: results.filter((r) => r.opened).length, results };
}

/** Step 2: a group on every open patio job with a priced work order and 2+ crew. */
export async function autoGroupPatioJobs(client: any) {
  const empty = { switched_on: false, created: 0, crew_added: 0, results: [] as PatioAutoGroupResult[] };
  if (!(await flagOn(client, GROUP_WORK_ORDER_AUTO_PATIO_FLAG))) return empty;
  if (!(await groupFeatureOn(client))) return empty;
  const results: PatioAutoGroupResult[] = [];
  try {
    const { data: wos, error } = await client.from("work_orders").select(
      "id, job_id, agreed_labour_ex, sealed_content_hash, approved_by, jobs:job_id!inner(id, org_id, job_number, type, status, work_order_id)",
    ).eq("kind", "job").eq("status", "approved").gt("agreed_labour_ex", 0)
      .not("sealed_content_hash", "is", null)
      .eq("jobs.type", "patio").in("jobs.status", [...JOB_WORK_ORDER_OPEN_STATUSES])
      .limit(500);
    if (error) throw new Error("work orders unreadable");
    const live = (wos || []).filter((w: any) =>
      w.jobs && String(w.jobs.work_order_id || "") === String(w.id)
    );
    const jobIds = live.map((w: any) => String(w.job_id));
    if (jobIds.length === 0) return { ...empty, switched_on: true };
    const crew = await readCrew(client, jobIds);
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
        const r = await topUpCrew(client, group, people);
        if (r) results.push({ ...base, ...r });
        continue;
      }
      if (people.length < PATIO_AUTO_GROUP_MIN_CREW) continue;
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
      const { error: crewError } = await client.from("group_work_order_participants").insert(
        people.map((userId) => ({ group_id: groupId, user_id: userId })),
      );
      if (crewError) console.error("[patio-auto-group] crew not added:", groupId, crewError.message);
      await logEvent(client, jobId, "group_work_order_auto_created", {
        group_id: groupId,
        work_order_id: String(wo.id),
        crew: people.length,
      });
      results.push({ ...base, reason: "group_created", group_id: groupId, added: crewError ? 0 : people.length });
    }
  } catch (e) {
    console.error("[patio-auto-group] sweep failed:", (e as Error)?.message);
  }
  return {
    switched_on: true,
    created: results.filter((r) => r.reason === "group_created").length,
    crew_added: results.filter((r) => r.reason === "crew_added").length,
    results,
  };
}

/** Crew allocated after the group opened join it, until its pay is frozen. */
async function topUpCrew(
  client: any,
  group: Record<string, unknown>,
  people: string[],
): Promise<Pick<PatioAutoGroupResult, "reason" | "group_id" | "added" | "code"> | null> {
  const groupId = String(group.id);
  if (group.status === "void") return null;
  if (group.split_frozen_at) return null;
  const { data: on, error } = await client.from("group_work_order_participants").select(
    "user_id",
  ).eq("group_id", groupId);
  if (error) return { reason: "group_failed", group_id: groupId, code: "crew_unreadable" };
  const have = new Set((on || []).map((r: any) => String(r.user_id)));
  const add = people.filter((id) => !have.has(id));
  if (add.length === 0) return null;
  const { error: addError } = await client.from("group_work_order_participants").insert(
    add.map((userId) => ({ group_id: groupId, user_id: userId })),
  );
  if (addError) return { reason: "group_failed", group_id: groupId, code: String(addError.code || "") };
  await logEvent(client, String(group.job_id), "group_work_order_auto_crew_added", {
    group_id: groupId,
    added: add.length,
  });
  return { reason: "crew_added", group_id: groupId, added: add.length };
}

async function logEvent(client: any, jobId: string, eventType: string, detail: Record<string, unknown>) {
  try {
    const { error } = await client.from("job_events").insert({
      job_id: jobId,
      event_type: eventType,
      user_id: null,
      detail_json: detail,
    });
    if (error) console.error("[patio-auto-group] event not logged:", eventType, error.message);
  } catch (e) {
    console.error("[patio-auto-group] event not logged:", eventType, (e as Error)?.message);
  }
}
