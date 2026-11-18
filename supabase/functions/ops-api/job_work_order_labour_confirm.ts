// deno-lint-ignore-file no-explicit-any
// FU49 item 9(a), option A: the office confirm list for a job work order's
// agreed labour. Contract: docs/job-work-order-labour-confirm-v1.md.
//
// The list: open jobs whose DRAFT job work order has no agreed labour. Each
// row proposes the job's SEALED budget amount (job_budgets, written at
// acceptance from the bound revision) and nothing else: never the quote's
// pricing estimate, never today's cost table (director, P1-05.5). A sealed
// budget with no labour amount proposes nothing and the row says so.
//
// The press: one call to confirm_job_work_order_labour (20261118170000),
// which re-reads the sealed budget under the work order's row lock, writes
// agreed_labour_ex on the draft and records who and when, in one transaction.
// Approving the work order stays the named approver's separate press.
//
// Both sit behind job_work_order_labour_confirm_v1 (seeded off; an unreadable
// switch is off). A list or budget read that fails refuses (503); it never
// reads as "nothing to confirm" or "no sealed amount".

import { readFlag } from "./job_work_orders.ts";
import { budgetAgreedLabour } from "./job_labour_cap.ts";
import { JOB_WORK_ORDER_OPEN_STATUSES } from "./job_work_order_quote_fill.ts";
import { JobWorkOrderOfficeError } from "./job_work_order_office.ts";

export const JOB_WORK_ORDER_LABOUR_CONFIRM_FLAG = "job_work_order_labour_confirm_v1";

/** What one office press does. Option A (firstmate 18 Nov): fill the draft
 *  only; a named approver still approves. Option B would add the approval to
 *  the press: change it here and in confirmJobWorkOrderLabour only. */
export const LABOUR_CONFIRM_PRESS = "fill_draft" as const;

export const LABOUR_CONFIRM_PAGE_DEFAULT = 25;
export const LABOUR_CONFIRM_PAGE_MAX = 50;

export type LabourConfirmActor = {
  staff: boolean;
  userId: string | null;
  orgId: string | null;
};

export type LabourProposalReason =
  | "sealed_amount"
  | "no_amount_in_sealed_quote"
  | "no_sealed_quote"
  | "revision_differs";

export type LabourConfirmRow = {
  job_id: string;
  job_number: string | null;
  job_type: string | null;
  job_status: string | null;
  work_order_id: string;
  wo_number: string | null;
  work_order_updated_at: string | null;
  reason: LabourProposalReason;
  /** null whenever reason is not sealed_amount: nothing is proposed. */
  proposal: {
    agreed_labour_ex: number;
    job_budget_id: string;
    scope_revision_id: string;
  } | null;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireStaff(actor: LabourConfirmActor): void {
  if (!actor.staff) {
    throw new JobWorkOrderOfficeError(
      403,
      "operator_access_required",
      "An authorised operator session is required.",
    );
  }
}

// An unreadable switch reads as off (readFlag): the feature stays shut and
// nothing is written. The database re-reads the switch inside the press.
async function switchOn(client: any): Promise<boolean> {
  return await readFlag(client, JOB_WORK_ORDER_LABOUR_CONFIRM_FLAG);
}

function pageParams(query: URLSearchParams | Record<string, unknown> | null) {
  const get = (k: string) =>
    query instanceof URLSearchParams ? query.get(k) : (query as any)?.[k];
  const rawLimit = Number(get("limit"));
  const rawOffset = Number(get("offset"));
  const limit = Number.isInteger(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, LABOUR_CONFIRM_PAGE_MAX)
    : LABOUR_CONFIRM_PAGE_DEFAULT;
  const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  return { limit, offset };
}

/** Pure. The proposal for one draft, from the job's newest sealed budget. */
export function labourProposalFor(
  workOrder: { quote_filled_scope_revision_id?: string | null },
  budget: { id: string; scope_revision_id: string; work_order_amount: unknown } | null,
): Pick<LabourConfirmRow, "reason" | "proposal"> {
  if (!budget) return { reason: "no_sealed_quote", proposal: null };
  const filledFrom = workOrder.quote_filled_scope_revision_id ?? null;
  if (filledFrom && filledFrom !== budget.scope_revision_id) {
    return { reason: "revision_differs", proposal: null };
  }
  const amount = budgetAgreedLabour({
    labour: { work_order_amount_ex_gst: budget.work_order_amount },
  });
  if (amount === null) return { reason: "no_amount_in_sealed_quote", proposal: null };
  return {
    reason: "sealed_amount",
    proposal: {
      agreed_labour_ex: amount,
      job_budget_id: budget.id,
      scope_revision_id: budget.scope_revision_id,
    },
  };
}

/** Office list: open jobs whose draft job work order has no agreed labour,
 *  oldest first, one page at a time. `more` is true when there are more than
 *  `limit` rows from `offset`; the answer never claims a total it did not
 *  count. */
export async function listJobWorkOrderLabourConfirm(
  client: any,
  query: URLSearchParams | Record<string, unknown> | null,
  actor: LabourConfirmActor,
): Promise<Record<string, unknown>> {
  requireStaff(actor);
  if (!actor.orgId) {
    throw new JobWorkOrderOfficeError(
      403,
      "operator_access_required",
      "Staff access to a company is required.",
    );
  }
  if (!(await switchOn(client))) {
    return { enabled: false, press: LABOUR_CONFIRM_PRESS, jobs: [], more: false };
  }
  const { limit, offset } = pageParams(query);
  // work_orders: idx_work_orders_kind / idx_wo_status narrow to draft job
  // orders (a small set); jobs joins by its primary key.
  const { data, error } = await client.from("work_orders")
    .select(
      "id, job_id, wo_number, updated_at, created_at, quote_filled_scope_revision_id, jobs:job_id!inner(id, job_number, type, status, org_id)",
    )
    .eq("org_id", actor.orgId)
    .eq("kind", "job")
    .eq("status", "draft")
    .is("agreed_labour_ex", null)
    .eq("jobs.org_id", actor.orgId)
    .in("jobs.status", [...JOB_WORK_ORDER_OPEN_STATUSES])
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .range(offset, offset + limit);
  if (error || !Array.isArray(data)) {
    throw new JobWorkOrderOfficeError(
      503,
      "labour_confirm_list_unreadable",
      "The list of work orders waiting for an agreed amount could not be read.",
    );
  }
  const more = data.length > limit;
  const page = data.slice(0, limit);
  const jobIds = [...new Set(page.map((r: any) => String(r.job_id)).filter((id) => UUID_RE.test(id)))];

  // Newest sealed budget per job (job_budgets_version_unique (job_id, version)).
  const newest = new Map<string, any>();
  if (jobIds.length > 0) {
    const { data: budgets, error: budgetError } = await client.from("job_budgets")
      .select("id, job_id, version, scope_revision_id, work_order_amount:budget->labour->work_order_amount_ex_gst")
      .in("job_id", jobIds)
      .order("job_id", { ascending: true })
      .order("version", { ascending: false });
    if (budgetError || !Array.isArray(budgets)) {
      throw new JobWorkOrderOfficeError(
        503,
        "labour_confirm_budget_unreadable",
        "The jobs' sealed budgets could not be read.",
      );
    }
    for (const b of budgets) {
      const key = String(b?.job_id);
      const seen = newest.get(key);
      if (!seen || Number(b.version) > Number(seen.version)) newest.set(key, b);
    }
  }

  const jobs: LabourConfirmRow[] = page.map((row: any) => {
    const job = row.jobs || {};
    const b = newest.get(String(row.job_id)) ?? null;
    const budget = b && b.id && b.scope_revision_id
      ? {
        id: String(b.id),
        scope_revision_id: String(b.scope_revision_id),
        work_order_amount: b.work_order_amount,
      }
      : null;
    return {
      job_id: String(row.job_id),
      job_number: job.job_number ?? null,
      job_type: job.type ?? null,
      job_status: job.status ?? null,
      work_order_id: String(row.id),
      wo_number: row.wo_number ?? null,
      work_order_updated_at: row.updated_at ?? null,
      ...labourProposalFor(row, budget),
    };
  });
  return {
    enabled: true,
    press: LABOUR_CONFIRM_PRESS,
    limit,
    offset,
    more,
    ...(more ? { more_than: offset + limit } : {}),
    jobs,
  };
}

const REFUSAL_STATUS: Record<string, number> = {
  labour_confirm_off: 409,
  confirm_input_required: 400,
  operator_access_required: 403,
  work_order_not_found: 404,
  work_order_not_draft: 409,
  work_order_has_amount: 409,
  job_not_open: 409,
  no_sealed_budget: 409,
  no_amount_in_sealed_quote: 409,
  revision_differs: 409,
  proposal_changed: 409,
};

/** The one press. Needs a signed-in office person (the record names them);
 *  the server key alone is refused. The amount comes from the sealed budget
 *  the database re-reads; the caller only echoes what it was shown. */
export async function confirmJobWorkOrderLabour(
  client: any,
  body: any,
  actor: LabourConfirmActor,
): Promise<Record<string, unknown>> {
  requireStaff(actor);
  if (!actor.userId || !actor.orgId) {
    throw new JobWorkOrderOfficeError(
      403,
      "signed_in_person_required",
      "Confirming an agreed amount needs a signed-in office person.",
    );
  }
  if (!(await switchOn(client))) {
    throw new JobWorkOrderOfficeError(409, "labour_confirm_off", "Confirming agreed labour is switched off.");
  }
  const workOrderId = String(body?.work_order_id ?? "").trim();
  const budgetId = String(body?.job_budget_id ?? "").trim();
  const expected = Number(body?.agreed_labour_ex);
  if (
    !UUID_RE.test(workOrderId) || !UUID_RE.test(budgetId) ||
    body?.agreed_labour_ex === null || body?.agreed_labour_ex === undefined ||
    body?.agreed_labour_ex === "" || !Number.isFinite(expected) || expected < 0
  ) {
    throw new JobWorkOrderOfficeError(
      400,
      "confirm_input_required",
      "work_order_id, job_budget_id and the proposed agreed_labour_ex are required.",
    );
  }
  let data: any;
  try {
    const res = await client.rpc("confirm_job_work_order_labour", {
      p_work_order_id: workOrderId,
      p_job_budget_id: budgetId,
      p_expected_ex: Math.round(expected * 100) / 100,
      p_actor: actor.userId,
      p_org_id: actor.orgId,
    });
    if (res?.error) throw new Error("rpc");
    data = res?.data;
  } catch {
    throw new JobWorkOrderOfficeError(
      503,
      "labour_confirm_failed",
      "The agreed amount could not be confirmed. Nothing was saved; read the list again.",
    );
  }
  const state = data?.state;
  if (state === "confirmed" || state === "already_confirmed") {
    return { ...data, press: LABOUR_CONFIRM_PRESS };
  }
  const code = typeof data?.code === "string" && data.code in REFUSAL_STATUS
    ? data.code
    : "labour_confirm_failed";
  throw new JobWorkOrderOfficeError(
    REFUSAL_STATUS[code] ?? 503,
    code,
    "The agreed amount was not confirmed.",
  );
}
