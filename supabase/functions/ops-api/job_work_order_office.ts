// deno-lint-ignore-file no-explicit-any
// Office queue for blank and draft job work orders, and the per-line review
// that holds a crew invoice out of Xero. Contract:
// docs/job-work-order-crew-invoices-v1.md.
//
// Writes go through decideOfficeWrite. The database seal still checks the
// approver. This module never calls Xero and never sets
// trade_invoice_lines.job_work_order_id.

import { readFlag } from "./job_work_orders.ts";
import {
  CREW_INVOICE_LINE_OFFICE_REVIEW_FLAG,
  decideOfficeQueue,
  decideOfficeWrite,
  JOB_WORK_ORDER_ALL_TYPES_FLAG,
  JOB_WORK_ORDER_OFFICE_FILL_FLAG,
  jobTypeOpensWorkOrder,
  type OfficeWriteAction,
  xeroSyncRefusal,
} from "./crew_invoice_job_work_order.ts";

export class JobWorkOrderOfficeError extends Error {
  status: number;
  code: string;
  body: Record<string, unknown>;
  constructor(
    status: number,
    code: string,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = { error: message, code, ...extra };
  }
}

export interface OfficeActor {
  staff: boolean;
  userId: string | null;
}

const QUEUE_COLUMNS =
  "id, job_id, wo_number, status, agreed_labour_ex, updated_at, site_address, origin, hand_edited_at, jobs:job_id(id, job_number, type, status, client_name, site_suburb)";

async function approverLists(client: any): Promise<{
  primaryIds: string[];
  backupIds: string[];
}> {
  const { data, error } = await client.from("work_order_settings")
    .select("approver_user_ids, backup_approver_user_ids")
    .eq("id", 1)
    .maybeSingle();
  if (error) {
    throw new JobWorkOrderOfficeError(
      503,
      "approvers_unreadable",
      "The work-order approver list could not be read.",
    );
  }
  return {
    primaryIds: Array.isArray(data?.approver_user_ids)
      ? data.approver_user_ids.map(String)
      : [],
    backupIds: Array.isArray(data?.backup_approver_user_ids)
      ? data.backup_approver_user_ids.map(String)
      : [],
  };
}

async function assertOfficeWrite(
  client: any,
  actor: OfficeActor,
  action: OfficeWriteAction,
): Promise<void> {
  const [officeFlagOn, reviewFlagOn, lists] = await Promise.all([
    readFlag(client, JOB_WORK_ORDER_OFFICE_FILL_FLAG),
    readFlag(client, CREW_INVOICE_LINE_OFFICE_REVIEW_FLAG),
    approverLists(client),
  ]);
  const decision = decideOfficeWrite({
    staff: actor.staff,
    userId: actor.userId,
    action,
    officeFlagOn,
    reviewFlagOn,
    primaryIds: lists.primaryIds,
    backupIds: lists.backupIds,
  });
  if (!decision.ok) {
    throw new JobWorkOrderOfficeError(
      decision.status,
      decision.code,
      decision.error,
    );
  }
}

export async function listOfficeJobWorkOrderQueue(
  client: any,
  actor: OfficeActor,
): Promise<{ enabled: boolean; work_orders: Record<string, unknown>[] }> {
  const gate = decideOfficeQueue({ staff: actor.staff });
  if (!gate.ok) {
    throw new JobWorkOrderOfficeError(gate.status, gate.code, gate.error);
  }
  const enabled = await readFlag(client, JOB_WORK_ORDER_OFFICE_FILL_FLAG);
  if (!enabled) return { enabled: false, work_orders: [] };
  const { data, error } = await client.from("work_orders")
    .select(QUEUE_COLUMNS)
    .eq("kind", "job")
    .eq("status", "draft")
    .order("updated_at", { ascending: true })
    .limit(200);
  if (error) {
    throw new JobWorkOrderOfficeError(
      503,
      "job_work_order_queue_unreadable",
      "The work-order queue could not be read.",
    );
  }
  const workOrders = (data || []).map((row: any) => {
    const job = row.jobs || {};
    return {
      id: row.id,
      job_id: row.job_id,
      wo_number: row.wo_number,
      status: row.status,
      agreed_labour_ex: row.agreed_labour_ex ?? null,
      needs_allowance: row.agreed_labour_ex == null,
      updated_at: row.updated_at,
      site_address: row.site_address ?? null,
      origin: row.origin ?? null,
      hand_edited_at: row.hand_edited_at ?? null,
      job_number: job.job_number ?? null,
      job_type: job.type ?? null,
      job_status: job.status ?? null,
      client_name: job.client_name ?? null,
      site_suburb: job.site_suburb ?? null,
    };
  });
  return { enabled: true, work_orders: workOrders };
}

function requireId(value: unknown, code: string, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new JobWorkOrderOfficeError(400, code, message);
  }
  return value.trim();
}

function parseAllowance(value: unknown): number {
  if (value === null || value === undefined || value === "") {
    throw new JobWorkOrderOfficeError(
      400,
      "allowance_required",
      "Set the labour allowance. Use 0 when there is none.",
    );
  }
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) {
    throw new JobWorkOrderOfficeError(
      400,
      "invalid_allowance",
      "The labour allowance must be zero or more.",
    );
  }
  return Math.round(amount * 100) / 100;
}

export async function fillJobWorkOrderAllowance(
  client: any,
  body: any,
  actor: OfficeActor,
): Promise<Record<string, unknown>> {
  await assertOfficeWrite(client, actor, "fill");
  const id = requireId(body?.work_order_id || body?.id, "work_order_id_required", "work_order_id is required");
  const expected = requireId(
    body?.expected_updated_at,
    "expected_updated_at_required",
    "expected_updated_at is required",
  );
  const amount = parseAllowance(body?.agreed_labour_ex ?? body?.labour_allowance);
  const { data: existing, error: readErr } = await client.from("work_orders")
    .select("id, kind, status, updated_at")
    .eq("id", id)
    .maybeSingle();
  if (readErr) {
    throw new JobWorkOrderOfficeError(503, "work_order_unreadable", "The work order could not be read.");
  }
  if (!existing || existing.kind !== "job") {
    throw new JobWorkOrderOfficeError(404, "work_order_not_found", "Work order not found.");
  }
  if (existing.status !== "draft") {
    throw new JobWorkOrderOfficeError(409, "work_order_not_draft", "Only a draft work order can be filled.");
  }
  if (String(existing.updated_at) !== String(expected)) {
    throw new JobWorkOrderOfficeError(
      409,
      "WO409",
      "The draft changed after it was read. Read it again before saving.",
    );
  }
  const { data: updated, error: updErr } = await client.from("work_orders")
    .update({ agreed_labour_ex: amount })
    .eq("id", id)
    .eq("kind", "job")
    .eq("status", "draft")
    .eq("updated_at", expected)
    .select("id, job_id, wo_number, status, agreed_labour_ex, updated_at")
    .maybeSingle();
  if (updErr) {
    throw new JobWorkOrderOfficeError(503, "work_order_fill_failed", "The labour allowance could not be saved.");
  }
  if (!updated) {
    throw new JobWorkOrderOfficeError(
      409,
      "WO409",
      "The draft changed after it was read. Read it again before saving.",
    );
  }
  return {
    work_order_id: updated.id,
    job_id: updated.job_id,
    wo_number: updated.wo_number,
    status: updated.status,
    agreed_labour_ex: updated.agreed_labour_ex,
    updated_at: updated.updated_at,
    needs_allowance: false,
  };
}

function throwApproveRpc(error: { code?: string; message?: string }): never {
  const code = String(error.code || "");
  const message = error.message || "The work order could not be approved.";
  if (code === "WO409") {
    throw new JobWorkOrderOfficeError(
      409,
      "WO409",
      "The draft changed after it was read. Read it again before approving.",
    );
  }
  if (code === "42501") {
    throw new JobWorkOrderOfficeError(403, "not_approver", message);
  }
  if (code === "P0002") {
    throw new JobWorkOrderOfficeError(404, "work_order_not_found", "Work order not found.");
  }
  if (code === "23514") {
    throw new JobWorkOrderOfficeError(409, "work_order_not_ready", message);
  }
  throw new JobWorkOrderOfficeError(500, "work_order_approve_failed", message);
}

export async function approveOfficeJobWorkOrder(
  client: any,
  body: any,
  actor: OfficeActor,
): Promise<Record<string, unknown>> {
  await assertOfficeWrite(client, actor, "approve");
  const id = requireId(body?.work_order_id || body?.id, "work_order_id_required", "work_order_id is required");
  const expected = requireId(
    body?.expected_updated_at,
    "expected_updated_at_required",
    "expected_updated_at is required",
  );
  const { data, error } = await client.rpc("approve_job_work_order", {
    p_work_order_id: id,
    p_approver: actor.userId,
    p_via: "session",
    p_expected_updated_at: expected,
  });
  if (error) throwApproveRpc(error);
  return { work_order: data };
}

const REVIEW_DECISIONS: Record<string, "approved" | "queried" | "rejected"> = {
  approve: "approved",
  approved: "approved",
  query: "queried",
  queried: "queried",
  reject: "rejected",
  rejected: "rejected",
};

export async function reviewCrewInvoiceLine(
  client: any,
  body: any,
  actor: OfficeActor,
): Promise<Record<string, unknown>> {
  await assertOfficeWrite(client, actor, "review");
  const lineId = requireId(body?.line_id || body?.trade_invoice_line_id, "line_id_required", "line_id is required");
  const decision = REVIEW_DECISIONS[String(body?.decision || "").trim().toLowerCase()];
  if (!decision) {
    throw new JobWorkOrderOfficeError(
      400,
      "invalid_decision",
      "decision must be approve, query, or reject.",
    );
  }
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 2000) : null;
  const { data: line, error: readErr } = await client.from("trade_invoice_lines")
    .select("id, trade_invoice_id, trade_invoices:trade_invoice_id(id, status, xero_bill_id)")
    .eq("id", lineId)
    .maybeSingle();
  if (readErr) {
    throw new JobWorkOrderOfficeError(503, "line_unreadable", "The invoice line could not be read.");
  }
  if (!line) {
    throw new JobWorkOrderOfficeError(404, "line_not_found", "Invoice line not found.");
  }
  const invoice = line.trade_invoices || {};
  if (invoice.xero_bill_id) {
    throw new JobWorkOrderOfficeError(
      409,
      "invoice_already_in_xero",
      "This invoice is already in Xero. Its lines cannot be reviewed here.",
    );
  }
  const { data: updated, error: updErr } = await client.from("trade_invoice_lines")
    .update({
      office_review_status: decision,
      office_reviewed_by: actor.userId,
      office_reviewed_at: new Date().toISOString(),
      office_review_note: note || null,
    })
    .eq("id", lineId)
    .select("id, trade_invoice_id, office_review_status, office_reviewed_at")
    .maybeSingle();
  if (updErr) {
    throw new JobWorkOrderOfficeError(503, "line_review_failed", "The line review could not be saved.");
  }
  if (!updated) {
    throw new JobWorkOrderOfficeError(404, "line_not_found", "Invoice line not found.");
  }
  const { data: siblings, error: sibErr } = await client.from("trade_invoice_lines")
    .select("office_review_status")
    .eq("trade_invoice_id", line.trade_invoice_id);
  if (sibErr) {
    throw new JobWorkOrderOfficeError(
      503,
      "line_unreadable",
      "The invoice lines could not be re-read after the review.",
    );
  }
  let invoiceStatus = invoice.status || null;
  let released = false;
  if (
    !xeroSyncRefusal(siblings || []) &&
    invoice.status === "pending_acknowledgment"
  ) {
    const { data: moved, error: statusErr } = await client.from("trade_invoices")
      .update({ status: "approved" })
      .eq("id", line.trade_invoice_id)
      .eq("status", "pending_acknowledgment")
      .is("xero_bill_id", null)
      .select("id, status")
      .maybeSingle();
    if (statusErr) {
      throw new JobWorkOrderOfficeError(
        503,
        "invoice_status_failed",
        "The line was reviewed, but the invoice status could not be updated.",
      );
    }
    if (moved?.status) {
      invoiceStatus = moved.status;
      released = true;
    }
  }
  return {
    line_id: updated.id,
    trade_invoice_id: updated.trade_invoice_id,
    office_review_status: updated.office_review_status,
    office_reviewed_at: updated.office_reviewed_at,
    invoice_status: invoiceStatus,
    ready_for_xero_push: released,
  };
}

/**
 * Opens a blank job work order for a non-fence, non-patio job. Does not fill
 * it from a quote. The caller only uses this while job_work_order_all_types_v1
 * is on; the database still refuses when that flag is off.
 */
export async function openBlankJobWorkOrder(
  client: any,
  body: any,
): Promise<Record<string, unknown>> {
  const jobId = requireId(body?.job_id || body?.jobId, "job_id_required", "job_id is required");
  const { data, error } = await client.rpc("ensure_job_work_order_draft", {
    p_job_id: jobId,
    p_origin: "manual",
  });
  if (error) {
    const code = String(error.code || "");
    if (code === "23514") {
      throw new JobWorkOrderOfficeError(
        422,
        "job_type_not_eligible",
        error.message || "This job cannot have a work order yet.",
      );
    }
    if (code === "P0002") {
      throw new JobWorkOrderOfficeError(404, "job_not_found", "Job not found.");
    }
    throw new JobWorkOrderOfficeError(500, "work_order_open_failed", error.message || "The work order could not be opened.");
  }
  const workOrderId = typeof data === "string" ? data : data?.id || data;
  const { data: row, error: readErr } = await client.from("work_orders")
    .select("id, job_id, wo_number, status, agreed_labour_ex, updated_at, origin")
    .eq("id", workOrderId)
    .maybeSingle();
  if (readErr || !row) {
    throw new JobWorkOrderOfficeError(503, "work_order_unreadable", "The work order was opened but could not be read back.");
  }
  return {
    work_order_id: row.id,
    job_id: row.job_id,
    wo_number: row.wo_number,
    status: row.status,
    agreed_labour_ex: row.agreed_labour_ex ?? null,
    needs_allowance: row.agreed_labour_ex == null,
    updated_at: row.updated_at,
    origin: row.origin,
  };
}

export async function shouldOpenBlankJobWorkOrder(
  client: any,
  body: any,
): Promise<boolean> {
  const jobId = body?.job_id || body?.jobId;
  if (typeof jobId !== "string" || !jobId) return false;
  if (!(await readFlag(client, JOB_WORK_ORDER_ALL_TYPES_FLAG))) return false;
  try {
    const { data, error } = await client.from("jobs").select("type").eq("id", jobId).maybeSingle();
    if (error || !data) return false;
    const type = String(data.type || "").trim();
    if (type === "fencing" || type === "patio") return false;
    return jobTypeOpensWorkOrder(type, true);
  } catch {
    return false;
  }
}
