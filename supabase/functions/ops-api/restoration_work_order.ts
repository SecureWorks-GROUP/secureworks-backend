// deno-lint-ignore-file no-explicit-any
// The ops-api Supabase client is intentionally untyped at this boundary,
// matching the sibling store modules.
//
// A restoration job's trade pay (owner, 12 Nov 2026): the office sets what the
// trade may bill for the job as an agreed labour amount on the job's work
// order, and the trade bills that work order instead of hours. Contract:
// docs/restoration-board-v1.md ("Trade pay").
//
// Why a work order and not an hourly rate: the trade's hourly rate is the
// office's, and a restoration job is often agreed at its own figure ("2 hours
// on site and 2 hours travel at $40"). The agreed amount is the trade's gross
// labour, exactly as hours x rate would be: super is worked out on it by the
// same trade invoice money rules as every other invoice, never taken out of it.
//
// It uses the job's ONE job work order (work_orders.kind = 'job') and the one
// database approval function, approve_job_work_order, so the trade invoice
// rules (trade_invoice_mode.ts: a restoration job with an approved work order
// is invoiced as a work order, at its agreed labour) need nothing new.
//
// Who may set it: an approver the database names (owner_approval_authority),
// either signed in, or named by an agent with the server key under the
// owner-directed fence (ses_owner_directed_approval.ts: the switch, an active
// admin_owner or captain operator, and their quoted words).

import {
  readOwnerApprovalAuthority,
  splitOwnerApprovalResult,
} from "./job_work_orders.ts";
import { resolveSesOwnerDirectedApproval } from "./ses_owner_directed_approval.ts";
import { RestorationWorkflowError } from "./restoration_workflow.ts";
import { isRestorationCard } from "./restoration_workflow_store.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const WO_COLUMNS =
  "id, org_id, job_id, kind, status, wo_number, agreed_labour_ex, special_instructions, updated_at";

export const RESTORATION_WORK_ORDER_MAX_EX = 100_000;

function fail(code: string, message: string, status = 400): never {
  throw new RestorationWorkflowError(code, message, status);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function dollars(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** Pure. The agreed amount: dollars ex GST, zero or more, cents exact. */
export function parseRestorationAgreedLabour(value: unknown): number {
  const n = typeof value === "number" ? value : Number(text(String(value ?? "")));
  if (value === null || value === undefined || value === "" || !Number.isFinite(n)) {
    fail(
      "agreed_labour_required",
      "Give the trade's agreed amount for this job in dollars ex GST (agreed_labour_ex), e.g. 160 for 4 hours at $40.",
    );
  }
  if (n < 0 || n > RESTORATION_WORK_ORDER_MAX_EX) {
    fail(
      "agreed_labour_invalid",
      `agreed_labour_ex must be between $0 and ${dollars(RESTORATION_WORK_ORDER_MAX_EX)}.`,
    );
  }
  return Math.round(n * 100) / 100;
}

export interface RestorationWorkOrderAuth {
  authMode: "api_key" | "jwt" | "routine";
  userId: string | null;
  orgId: string | null;
  relayedBy: string | null;
}

async function resolveApprover(
  client: any,
  auth: RestorationWorkOrderAuth,
  body: any,
): Promise<{ userId: string; via: "session" | "terminal"; evidence: Record<string, unknown> | null }> {
  if (auth.authMode === "jwt") {
    if (!auth.userId || !UUID_RE.test(auth.userId)) {
      fail("approver_identity_missing", "Setting a work order needs your own signed-in session.", 403);
    }
    return { userId: auth.userId, via: "session", evidence: null };
  }
  if (auth.authMode !== "api_key") {
    fail("operator_access_required", "A routine cannot set a work order.", 403);
  }
  const directed = await resolveSesOwnerDirectedApproval(
    client,
    "api_key",
    { owner_email: body?.owner_email, owner_statement: body?.owner_statement },
    auth.relayedBy,
  );
  if (!directed.ok) {
    fail(directed.refusal.code, directed.refusal.fact, directed.status);
  }
  const userId = String(directed.auth.user?.id || "");
  if (!UUID_RE.test(userId)) fail("owner_not_found", "The named operator could not be resolved.", 403);
  return { userId, via: "terminal", evidence: directed.evidence_ref };
}

async function readJobWorkOrder(client: any, jobId: string): Promise<any | null> {
  const { data, error } = await client.from("work_orders").select(WO_COLUMNS)
    .eq("job_id", jobId).eq("kind", "job");
  if (error) fail("work_order_unreadable", "The job's work order could not be read.", 503);
  const rows = (data || []).filter((r: any) => r.status !== "cancelled" && r.status !== "void");
  return rows.find((r: any) => r.status === "approved") ||
    rows.find((r: any) => r.status === "draft") || null;
}

/**
 * WRITE. Set and approve the trade's agreed amount for a restoration job.
 * Body: job_id | job_number, agreed_labour_ex, breakdown (what it is for, e.g.
 * "Jean Crous: 2 h on site + 2 h travel at $40/h"), and, with the server key,
 * owner_email + owner_statement.
 */
export async function setRestorationWorkOrderAction(
  client: any,
  body: any,
  auth: RestorationWorkOrderAuth,
): Promise<Record<string, unknown>> {
  const agreed = parseRestorationAgreedLabour(body?.agreed_labour_ex);
  const breakdown = text(body?.breakdown);
  if (breakdown.length < 3) {
    fail(
      "breakdown_required",
      "Say what the amount is for (breakdown), e.g. \"Jean Crous: 2 h on site + 2 h travel at $40/h\". The trade sees it on the work order.",
    );
  }
  if (breakdown.length > 2000) fail("breakdown_too_long", "breakdown must be at most 2000 characters.");

  const approver = await resolveApprover(client, auth, body);
  const authority = await readOwnerApprovalAuthority(client, approver.userId);
  if (!authority) {
    fail(
      "approver_required",
      "Only the owner or an approver named in the work order settings sets a restoration work order.",
      403,
    );
  }

  const jobId = text(body?.job_id);
  const jobNumber = text(body?.job_number).toUpperCase();
  if (!jobId && !jobNumber) fail("job_required", "job_id or job_number is required.");
  if (jobId && !UUID_RE.test(jobId)) fail("job_id_invalid", "job_id must be a job UUID.");
  let query = client.from("jobs").select("id, org_id, job_number, type, status, metadata");
  query = jobId ? query.eq("id", jobId) : query.eq("job_number", jobNumber);
  const { data: job, error: jobError } = await query.maybeSingle();
  if (jobError) fail("job_unreadable", "The job could not be read.", 503);
  if (!job || (auth.orgId && job.org_id && job.org_id !== auth.orgId)) {
    fail("job_not_found", "No job matched.", 404);
  }
  if (!isRestorationCard(job)) {
    fail("not_a_restoration_job", `${job.job_number || "This job"} is not a restoration job.`, 409);
  }

  let wo = await readJobWorkOrder(client, job.id);
  if (!wo) {
    const { error } = await client.rpc("ensure_job_work_order_draft", {
      p_job_id: job.id,
      p_origin: "manual",
    });
    if (error) {
      fail("work_order_not_opened", `The job's work order could not be opened (${text(error.message)}).`, 503);
    }
    wo = await readJobWorkOrder(client, job.id);
    if (!wo) fail("work_order_not_opened", "The job's work order could not be opened.", 503);
  }

  if (wo.status === "approved") {
    const current = Number(wo.agreed_labour_ex);
    if (Math.abs(current - agreed) <= 0.005) {
      return {
        success: true,
        unchanged: true,
        job_number: job.job_number,
        work_order: { id: wo.id, wo_number: wo.wo_number, status: wo.status, agreed_labour_ex: current },
      };
    }
    fail(
      "work_order_sealed",
      `${job.job_number}'s work order is already agreed at ${dollars(current)} and approved work orders are sealed. A change is a variation on the job.`,
      409,
    );
  }

  const { data: patched, error: patchError } = await client.from("work_orders")
    .update({ agreed_labour_ex: agreed, special_instructions: breakdown })
    .eq("id", wo.id).eq("kind", "job").eq("status", "draft")
    .select(WO_COLUMNS).maybeSingle();
  if (patchError) fail("work_order_not_saved", `The work order could not be saved (${text(patchError.message)}).`, 503);
  if (!patched) fail("work_order_changed", "The work order changed while this was being saved. Try again.", 409);

  const orgId = String(job.org_id || auth.orgId || "");
  const { data: approved, error: approveError } = await client.rpc("approve_job_work_order", {
    p_work_order_id: patched.id,
    p_approver: approver.userId,
    p_via: approver.via,
    p_expected_updated_at: patched.updated_at,
    p_org_id: orgId || null,
  });
  if (approveError) {
    fail(
      "work_order_not_approved",
      `The amount is saved on the draft but the work order was not approved (${text(approveError.message) || "refused"}).`,
      409,
    );
  }
  const { workOrder, issued } = splitOwnerApprovalResult(approved);
  try {
    await client.from("job_events").insert({
      job_id: job.id,
      user_id: approver.userId,
      event_type: "restoration_work_order_set",
      detail_json: {
        work_order_id: patched.id,
        wo_number: patched.wo_number || null,
        breakdown,
        approved_by: approver.userId,
        via: approver.via,
        issued,
        owner_directive: approver.evidence,
      },
    });
  } catch (_e) { /* the work order is the record; the event is the audit */ }
  return {
    success: true,
    job_number: job.job_number,
    work_order: {
      id: patched.id,
      wo_number: workOrder?.wo_number ?? patched.wo_number ?? null,
      status: workOrder?.status ?? null,
      agreed_labour_ex: agreed,
      breakdown,
    },
    issued,
    note: issued
      ? `The trade now bills ${job.job_number} as a work order of ${dollars(agreed)} ex GST. Super is worked out on it like any trade invoice.`
      : "The amount is recorded but the work order is not issued yet; see the work order for what it waits on.",
  };
}
