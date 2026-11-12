// How a trade invoices a job (Marnin, 11 Nov 2026). Each job is invoiced ONE
// way, decided by the job (and, for a per-metre trade, by the trade), never
// chosen by the trade on the screen:
//
//   1. the job has a live (not void) group work order -> group work order
//   2. the trade is per metre (users.invoice_type = 'per_metre') -> work order
//   3. a patio job -> group work order
//   4. a fencing job -> work order
//   5. everything else (make-safe, repair, other) -> hourly
//
// The job's vertical is read the way the rest of ops-api reads it (repair
// family first: a repair-family card typed makesafe or fencing is repair), so
// the caller passes index.ts's _jobVertical in.
//
// Commission is not a mode. It is an extra line a trade may add only on a job
// they created, a job in a division they manage, or with the office's
// invoice-any-job grant: `can_claim_commission` reads that through the ONE
// rule list in trade_invoice_extra_job_authority.ts, never restated here.
//
// This module only answers the question. It refuses nothing: the existing
// write paths keep their own checks (fencing helpers are still paid by the
// hour on fencing jobs, so no hourly line is refused here).
//
// Contract: docs/trade-invoice-mode-v1.md.
// deno-lint-ignore-file no-explicit-any

import { tradeMayClaimCommission } from "./trade_invoice_extra_job_authority.ts";

export type TradeInvoiceMode = "group_work_order" | "work_order" | "hourly";

export type TradeInvoiceModeReason =
  | "live_group_work_order"
  | "per_metre_trade"
  | "patio_job"
  | "fencing_job"
  | "other_job";

export type TradeInvoiceModeDecision = {
  invoice_mode: TradeInvoiceMode;
  invoice_mode_reason: TradeInvoiceModeReason;
};

export type TradeInvoiceJobMode = TradeInvoiceModeDecision & {
  job_id: string;
  can_claim_commission: boolean;
};

/** The owner's rule, in order. Pure. */
export function decideTradeInvoiceMode(input: {
  hasLiveGroupWorkOrder: boolean;
  tradeInvoiceType: string | null | undefined;
  jobVertical: string | null | undefined;
}): TradeInvoiceModeDecision {
  if (input.hasLiveGroupWorkOrder) {
    return {
      invoice_mode: "group_work_order",
      invoice_mode_reason: "live_group_work_order",
    };
  }
  if (String(input.tradeInvoiceType || "").trim().toLowerCase() === "per_metre") {
    return { invoice_mode: "work_order", invoice_mode_reason: "per_metre_trade" };
  }
  const vertical = String(input.jobVertical || "").trim().toLowerCase();
  if (vertical === "patio") {
    return { invoice_mode: "group_work_order", invoice_mode_reason: "patio_job" };
  }
  if (vertical === "fencing") {
    return { invoice_mode: "work_order", invoice_mode_reason: "fencing_job" };
  }
  return { invoice_mode: "hourly", invoice_mode_reason: "other_job" };
}

/** A group work order holds the job unless it is void (same rule as my_hours). */
export function isLiveGroupWorkOrder(row: any): boolean {
  return !!row?.job_id && String(row?.status || "") !== "void";
}

export class TradeInvoiceModeReadError extends Error {
  constructor(what: string) {
    super(`Could not read ${what} to decide how these jobs are invoiced`);
  }
}

const CHUNK = 50;

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Reads the trade, the jobs (inside the trade's company only) and their group
 * work orders, and decides each job. Every read error throws
 * TradeInvoiceModeReadError: an unreadable group never reads as "no group".
 * Job ids not found in the trade's company are returned in `not_found`.
 */
export async function loadTradeInvoiceJobModes(
  client: any,
  input: {
    tradeId: string;
    // The caller's company as the auth layer resolved it. When given, the
    // trade's own row must be in it (else nothing is decided).
    orgId?: string | null;
    jobIds: readonly string[];
    jobVertical: (job: any) => string;
    normaliseManagedVerticals: (value: unknown) => string[];
  },
): Promise<{ jobs: TradeInvoiceJobMode[]; not_found: string[] }> {
  const ids = [
    ...new Set(input.jobIds.map((id) => String(id || "").trim()).filter(Boolean)),
  ];
  if (ids.length === 0) return { jobs: [], not_found: [] };

  const { data: user, error: userError } = await client.from("users")
    .select(
      "id, org_id, invoice_type, managed_verticals, invoice_any_job:trade_details->invoiceAnyJob",
    )
    .eq("id", input.tradeId)
    .maybeSingle();
  if (userError) throw new TradeInvoiceModeReadError("your profile");
  if (!user?.id || !user?.org_id) throw new TradeInvoiceModeReadError("your profile");
  const orgId = String(user.org_id);
  if (input.orgId && String(input.orgId) !== orgId) {
    throw new TradeInvoiceModeReadError("your company");
  }

  const jobs = new Map<string, any>();
  const liveGroupJobs = new Set<string>();
  for (const part of chunks(ids)) {
    const [jobsRes, groupsRes] = await Promise.all([
      client.from("jobs")
        .select("id, org_id, type, job_number, metadata, created_by")
        .eq("org_id", orgId)
        .in("id", part),
      client.from("group_work_orders")
        .select("job_id, status")
        .in("job_id", part),
    ]);
    if (jobsRes.error) throw new TradeInvoiceModeReadError("the jobs");
    if (groupsRes.error) throw new TradeInvoiceModeReadError("the group work orders");
    for (const row of jobsRes.data || []) {
      if (row?.id && String(row.org_id || orgId) === orgId) jobs.set(String(row.id), row);
    }
    for (const row of groupsRes.data || []) {
      if (isLiveGroupWorkOrder(row)) liveGroupJobs.add(String(row.job_id));
    }
  }

  const trade = {
    id: String(user.id),
    orgId,
    managedVerticals: input.normaliseManagedVerticals(user.managed_verticals),
    invoiceAnyJob: user.invoice_any_job === true,
  };
  const out: TradeInvoiceJobMode[] = [];
  const notFound: string[] = [];
  for (const id of ids) {
    const row = jobs.get(id);
    if (!row) {
      notFound.push(id);
      continue;
    }
    const vertical = input.jobVertical(row);
    out.push({
      job_id: id,
      ...decideTradeInvoiceMode({
        hasLiveGroupWorkOrder: liveGroupJobs.has(id),
        tradeInvoiceType: user.invoice_type,
        jobVertical: vertical,
      }),
      can_claim_commission: tradeMayClaimCommission({
        job: {
          id,
          createdBy: row.created_by ? String(row.created_by) : null,
          vertical,
        },
        trade,
      }),
    });
  }
  return { jobs: out, not_found: notFound };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TRADE_INVOICE_JOB_MODES_MAX = 50;

export class TradeInvoiceJobModesRequestError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** `job_ids` query value: comma-separated job uuids, 1 to 50, deduplicated. */
export function parseTradeInvoiceJobModeIds(raw: string | null | undefined): string[] {
  const ids = [
    ...new Set(
      String(raw || "").split(",").map((id) => id.trim()).filter(Boolean),
    ),
  ];
  if (ids.length === 0) {
    throw new TradeInvoiceJobModesRequestError(
      "job_ids_required",
      "Name at least one job (job_ids).",
    );
  }
  if (ids.length > TRADE_INVOICE_JOB_MODES_MAX) {
    throw new TradeInvoiceJobModesRequestError(
      "too_many_job_ids",
      `Ask about at most ${TRADE_INVOICE_JOB_MODES_MAX} jobs at a time.`,
    );
  }
  const bad = ids.filter((id) => !UUID_RE.test(id));
  if (bad.length > 0) {
    throw new TradeInvoiceJobModesRequestError(
      "job_ids_invalid",
      "One of those jobs is not a job id.",
    );
  }
  return ids;
}
