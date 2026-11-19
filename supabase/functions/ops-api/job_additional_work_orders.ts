// deno-lint-ignore-file no-explicit-any
// More than one work order on a job (owner, 19 Nov 2026): "a job might have a
// make-safe, a roof report, a resto job and a repair", each its own work
// order, and trades invoice the work order, not the job.
//
// The job keeps its one main work order (work_orders.kind = 'job'). Every
// further one is a row of kind 'additional' with its own number
// (WO-<job number>-<n>), title, scope, agreed amount and, optionally, the trade
// it is for. Approving it (approve_additional_work_order, migration
// 20261119090000) seals it and adds its amount to the main work order as a work
// order amount change, so every job-level rule (the invoice cap, the line
// hold, the pay run checks, the overbilled list, job profit) allows the job's
// whole agreed labour without change, and nothing is counted twice.
//
// Which work order a trade's job card bills (pickTradeWorkOrder): the job's
// work orders in order (main first, then the additional ones by approval),
// keeping those that are the job's own or for this trade, are covered in turn
// by what this trade has billed on the job; the first one not yet covered is
// the one the card bills, at exactly its agreed amount. So a trade who billed
// the $80 inspection is next offered the $352 restoration, with no change to
// the trade app.
//
// Super is not worked out here: every amount includes super under the one
// super rule (trade_invoice_money.ts, inclusive_12_112_v1), which prices the
// invoice the trade sends.
//
// Contract: docs/job-additional-work-orders-v1.md.

import {
  JOB_WORK_ORDER_BILLED_INVOICE_STATUSES,
  readOwnerApprovalAuthority,
} from "./job_work_orders.ts";
import { resolveSesOwnerDirectedApproval } from "./ses_owner_directed_approval.ts";

export const ADDITIONAL_WORK_ORDER_SCHEMA = "job-work-orders.v1";
export const ADDITIONAL_WORK_ORDER_MAX_EX = 100_000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ROW_COLUMNS =
  "id, org_id, job_id, kind, status, wo_number, title, agreed_labour_ex, scope_items, special_instructions, scheduled_date, site_address, assigned_user_id, trade_name, approved_at, approved_by, approved_via, main_work_order_id, amount_change_id, created_at, updated_at";

export class AdditionalWorkOrderError extends Error {
  status: number;
  code: string;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function fail(code: string, message: string, status = 400): never {
  throw new AdditionalWorkOrderError(code, message, status);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cents(n: number): number {
  return Math.round(n * 100);
}

function money(n: number): number {
  return Math.round(n * 100) / 100;
}

function dollars(n: number): string {
  return `$${money(n).toFixed(2)}`;
}

// ── Which work order a trade bills ───────────────────────────────────────────

export type TradeWorkOrderOption = {
  id: string;
  wo_number: string | null;
  title: string | null;
  agreed_ex: number;
  /** The job's main work order (kind 'job'). */
  main: boolean;
  /** Covered by what this trade has already billed on the job. */
  billed: boolean;
};

export type JobWorkOrderRow = {
  id: string;
  kind: string;
  wo_number?: string | null;
  title?: string | null;
  agreed_labour_ex: unknown;
  approved_at?: string | null;
  assigned_user_id?: string | null;
};

/**
 * Pure. The job's approved work orders this trade may bill, in order, each
 * marked billed once what the trade has billed on the job covers it, and the
 * first one still open (null when all are billed).
 */
export function pickTradeWorkOrder(
  rows: readonly JobWorkOrderRow[],
  tradeId: string,
  billedEx: number,
): { options: TradeWorkOrderOption[]; open: TradeWorkOrderOption | null } {
  const usable = rows
    .filter((r) => r && (r.kind === "job" || r.kind === "additional"))
    .filter((r) => {
      const n = Number(r.agreed_labour_ex);
      return r.agreed_labour_ex !== null && r.agreed_labour_ex !== undefined &&
        r.agreed_labour_ex !== "" && Number.isFinite(n) && n >= 0;
    })
    .filter((r) =>
      r.kind === "job" || !r.assigned_user_id ||
      String(r.assigned_user_id) === String(tradeId)
    )
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "job" ? -1 : 1;
      const at = String(a.approved_at || "").localeCompare(String(b.approved_at || ""));
      return at !== 0 ? at : String(a.id).localeCompare(String(b.id));
    });
  let left = cents(Number.isFinite(billedEx) ? billedEx : 0);
  let open: TradeWorkOrderOption | null = null;
  const options = usable.map((r) => {
    const agreed = money(Number(r.agreed_labour_ex));
    let billed = false;
    if (!open && left >= cents(agreed)) {
      left -= cents(agreed);
      billed = true;
    }
    const option: TradeWorkOrderOption = {
      id: String(r.id),
      wo_number: r.wo_number ?? null,
      title: r.title ?? null,
      agreed_ex: agreed,
      main: r.kind === "job",
      billed,
    };
    if (!billed && !open) open = option;
    return option;
  });
  return { options, open };
}

/** Lines that are not paid work: never counted against a work order. */
const NOT_WORK_LINE_TYPES = new Set(["commission", "reimbursement"]);

/**
 * What this trade has billed on each job, ex GST, on invoices that count
 * (job_work_order_billed_invoice_statuses). Throws on a failed read: an
 * unreadable invoice is never read as "nothing billed".
 */
export async function readTradeBilledOnJobs(
  client: any,
  tradeId: string,
  jobIds: readonly string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = [...new Set(jobIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50);
    for (let offset = 0;; offset += 1000) {
      const { data, error } = await client.from("trade_invoice_lines")
        .select("id, job_id, line_type, line_total_ex, trade_invoices!inner(user_id, status)")
        .eq("trade_invoices.user_id", tradeId)
        .in("job_id", part)
        .order("id")
        .range(offset, offset + 999);
      if (error) throw new AdditionalWorkOrderError("billed_unreadable", "What you have billed on these jobs could not be read.", 503);
      for (const row of data || []) {
        const status = String(row?.trade_invoices?.status || "");
        if (!JOB_WORK_ORDER_BILLED_INVOICE_STATUSES.has(status)) continue;
        if (NOT_WORK_LINE_TYPES.has(String(row?.line_type || "").trim().toLowerCase())) continue;
        const n = Number(row?.line_total_ex);
        if (!Number.isFinite(n)) continue;
        const jobId = String(row.job_id);
        out.set(jobId, money((out.get(jobId) || 0) + n));
      }
      if ((data || []).length < 1000) break;
    }
  }
  return out;
}

// ── Office: add a work order to a job ────────────────────────────────────────

export interface AdditionalWorkOrderAuth {
  authMode: "api_key" | "jwt" | "routine";
  userId: string | null;
  orgId: string | null;
  relayedBy: string | null;
}

async function resolveApprover(
  client: any,
  auth: AdditionalWorkOrderAuth,
  body: any,
): Promise<{ userId: string; via: "session" | "terminal"; evidence: Record<string, unknown> | null }> {
  if (auth.authMode === "jwt") {
    if (!auth.userId || !UUID_RE.test(auth.userId)) {
      fail("approver_identity_missing", "Adding a work order needs your own signed-in session.", 403);
    }
    return { userId: auth.userId, via: "session", evidence: null };
  }
  if (auth.authMode !== "api_key") {
    fail("operator_access_required", "A routine cannot add a work order.", 403);
  }
  const directed = await resolveSesOwnerDirectedApproval(
    client,
    "api_key",
    { owner_email: body?.owner_email, owner_statement: body?.owner_statement },
    auth.relayedBy,
  );
  if (!directed.ok) fail(directed.refusal.code, directed.refusal.fact, directed.status);
  const userId = String(directed.auth.user?.id || "");
  if (!UUID_RE.test(userId)) fail("owner_not_found", "The named operator could not be resolved.", 403);
  return { userId, via: "terminal", evidence: directed.evidence_ref };
}

/** Pure. The agreed amount: dollars ex GST, more than 0, cents exact. */
export function parseAdditionalAgreed(value: unknown): number {
  const n = typeof value === "number" ? value : Number(text(String(value ?? "")));
  if (value === null || value === undefined || value === "" || !Number.isFinite(n)) {
    fail("agreed_labour_required", "Give the work order's agreed amount in dollars ex GST, including super (agreed_labour_ex), e.g. 352 for 8 hours at $44.");
  }
  if (n <= 0 || n > ADDITIONAL_WORK_ORDER_MAX_EX) {
    fail("agreed_labour_invalid", `agreed_labour_ex must be more than $0 and at most ${dollars(ADDITIONAL_WORK_ORDER_MAX_EX)}.`);
  }
  return money(n);
}

const MONEY_IN_TEXT = /\$|\b\d+(?:\.\d+)?\s*(?:\/\s*(?:hr|hour|h)|per\s+hour|an\s+hour)\b/i;

/** Pure. Trades read every word of a work order: no amount or rate in it. */
export function assertNoMoneyInText(value: string, field: string): void {
  if (MONEY_IN_TEXT.test(value)) {
    fail("money_in_text", `${field} is read by the trade, so it cannot carry an amount or a rate. Put the amount in agreed_labour_ex.`);
  }
}

/** Pure. Scope lines: [{description, qty?, unit?, hours?}], each with words. */
export function parseScopeItems(value: unknown): Array<Record<string, unknown>> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail("invalid_scope_items", "scope_items must be a list of {description, qty?, unit?, hours?}.");
  if (value.length > 60) fail("invalid_scope_items", "A work order holds at most 60 scope lines.");
  return value.map((item: any, i: number) => {
    const description = text(typeof item === "string" ? item : item?.description);
    if (!description || description.length > 1000) {
      fail("invalid_scope_items", `Scope line ${i + 1} needs a description of at most 1000 characters.`);
    }
    assertNoMoneyInText(description, `Scope line ${i + 1}`);
    const out: Record<string, unknown> = { description };
    for (const key of ["qty", "hours"] as const) {
      const raw = item?.[key];
      if (raw === undefined || raw === null || raw === "") continue;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) fail("invalid_scope_items", `Scope line ${i + 1}: ${key} must be a number.`);
      out[key] = n;
    }
    const unit = text(item?.unit);
    if (unit) out.unit = unit.slice(0, 20);
    return out;
  });
}

async function readJobByRef(client: any, body: any, orgId: string | null) {
  const jobId = text(body?.job_id);
  const jobNumber = text(body?.job_number).toUpperCase();
  if (!jobId && !jobNumber) fail("job_required", "job_id or job_number is required.");
  if (jobId && !UUID_RE.test(jobId)) fail("job_id_invalid", "job_id must be a job UUID.");
  let query = client.from("jobs").select("id, org_id, job_number, type, status, site_address, site_suburb");
  query = jobId ? query.eq("id", jobId) : query.eq("job_number", jobNumber);
  const { data: job, error } = await query.maybeSingle();
  if (error) fail("job_unreadable", "The job could not be read.", 503);
  if (!job || (orgId && job.org_id && job.org_id !== orgId)) fail("job_not_found", "No job matched.", 404);
  return job;
}

async function readJobWorkOrderRows(client: any, jobId: string): Promise<any[]> {
  const { data, error } = await client.from("work_orders").select(ROW_COLUMNS)
    .eq("job_id", jobId).in("kind", ["job", "additional"])
    .order("created_at", { ascending: true });
  if (error) fail("work_orders_unreadable", "The job's work orders could not be read.", 503);
  return data || [];
}

/** Pure. The next number: WO-<job number>-<n>, n one past the job's highest. */
export function nextAdditionalWorkOrderNumber(jobNumber: string, rows: readonly any[]): string {
  const base = `WO-${String(jobNumber || "").trim()}`;
  let highest = 1; // the main work order is number 1
  for (const r of rows) {
    const m = String(r?.wo_number || "").match(/-(\d+)$/);
    if (r?.kind === "additional" && m && String(r.wo_number).startsWith(`${base}-`)) {
      highest = Math.max(highest, Number(m[1]));
    }
  }
  return `${base}-${highest + 1}`;
}

/**
 * WRITE. Add a work order to a job and, unless `approve: false`, approve it.
 * Body: job_id | job_number, title, agreed_labour_ex (super inclusive),
 * scope_items?, special_instructions?, scheduled_date?, assigned_user_id?,
 * approve?, and with the server key owner_email + owner_statement.
 */
export async function addJobWorkOrderAction(
  client: any,
  body: any,
  auth: AdditionalWorkOrderAuth,
): Promise<Record<string, unknown>> {
  const title = text(body?.title);
  if (!title || title.length > 120) fail("title_required", "Give the work order a title of at most 120 characters, e.g. \"Restoration works\".");
  assertNoMoneyInText(title, "The title");
  const agreed = parseAdditionalAgreed(body?.agreed_labour_ex);
  const scopeItems = parseScopeItems(body?.scope_items);
  const instructions = text(body?.special_instructions);
  if (instructions.length > 4000) fail("special_instructions_too_long", "special_instructions must be at most 4000 characters.");
  if (instructions) assertNoMoneyInText(instructions, "special_instructions");
  if (scopeItems.length === 0 && !instructions) {
    fail("scope_required", "Say what the work is: scope_items, special_instructions, or both. The trade sees it on the work order.");
  }
  const scheduledDate = text(body?.scheduled_date);
  if (scheduledDate && !/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)) fail("scheduled_date_invalid", "scheduled_date must be YYYY-MM-DD.");
  const assigned = text(body?.assigned_user_id);
  if (assigned && !UUID_RE.test(assigned)) fail("assigned_user_id_invalid", "assigned_user_id must be a user UUID.");
  const approve = body?.approve !== false;

  const approver = await resolveApprover(client, auth, body);
  const authority = await readOwnerApprovalAuthority(client, approver.userId);
  if (!authority) fail("approver_required", "Only the owner or an approver named in the work order settings adds a work order.", 403);

  const job = await readJobByRef(client, body, auth.orgId);
  const rows = await readJobWorkOrderRows(client, job.id);
  const main = rows.find((r) => r.kind === "job" && r.status === "approved" && r.agreed_labour_ex != null);
  if (!main) {
    fail(
      "main_work_order_not_approved",
      `${job.job_number || "This job"} has no approved main work order yet. Approve that first (or set it with restoration_set_work_order); every further work order adds to it.`,
      409,
    );
  }

  let tradeName: string | null = null;
  if (assigned) {
    const { data: user, error } = await client.from("users").select("id, org_id, name").eq("id", assigned).maybeSingle();
    if (error) fail("assigned_user_unreadable", "The trade could not be read.", 503);
    if (!user || (user.org_id && user.org_id !== job.org_id)) fail("assigned_user_not_found", "That trade is not in this company.", 404);
    tradeName = user.name || null;
  }

  const woNumber = nextAdditionalWorkOrderNumber(job.job_number, rows);
  const { data: draft, error: insertError } = await client.from("work_orders").insert({
    org_id: job.org_id,
    job_id: job.id,
    kind: "additional",
    status: "draft",
    wo_number: woNumber,
    title,
    agreed_labour_ex: agreed,
    scope_items: scopeItems,
    special_instructions: instructions || null,
    scheduled_date: scheduledDate || null,
    site_address: [job.site_address, job.site_suburb].filter(Boolean).join(", ") || null,
    assigned_user_id: assigned || null,
    trade_name: tradeName,
    origin: "manual",
    created_by: approver.userId,
  }).select(ROW_COLUMNS).single();
  if (insertError || !draft) {
    fail("work_order_not_saved", `The work order could not be saved (${text(insertError?.message) || "no row"}).`, 503);
  }

  let approved: any = null;
  if (approve) {
    const { data, error } = await client.rpc("approve_additional_work_order", {
      p_work_order_id: draft.id,
      p_approver: approver.userId,
      p_via: approver.via,
      p_expected_updated_at: draft.updated_at,
      p_org_id: job.org_id,
    });
    if (error) {
      fail(
        "work_order_not_approved",
        `${woNumber} is saved as a draft but was not approved (${text(error.message) || "refused"}).`,
        409,
      );
    }
    approved = data;
  }

  try {
    await client.from("job_events").insert({
      job_id: job.id,
      user_id: approver.userId,
      // Ids and words only: job_events are read by trades, so no amount.
      event_type: approved ? "job_work_order_added" : "job_work_order_drafted",
      detail_json: {
        work_order_id: draft.id,
        wo_number: woNumber,
        title,
        main_work_order_id: approved?.main_work_order_id ?? null,
        assigned_user_id: assigned || null,
        via: approver.via,
        owner_directive: approver.evidence,
      },
    });
  } catch (_e) { /* the work order is the record; the event is the audit */ }

  const total = money(Number(main.agreed_labour_ex) + agreed +
    rows.filter((r) => r.kind === "additional" && r.status === "approved")
      .reduce((s, r) => s + (Number(r.agreed_labour_ex) || 0), 0));
  return {
    success: true,
    job_number: job.job_number,
    work_order: {
      id: draft.id,
      wo_number: woNumber,
      title,
      status: approved ? "approved" : "draft",
      agreed_labour_ex: agreed,
      assigned_user_id: assigned || null,
      main_work_order_id: approved?.main_work_order_id ?? null,
    },
    job_agreed_total_ex: approved ? total : null,
    note: approved
      ? `${woNumber} (${title}) is approved at ${dollars(agreed)} ex GST including super. The job's work orders now allow ${dollars(total)}. The trade bills it from the Pay tab at that amount.`
      : `${woNumber} is saved as a draft; approve it with approve_additional_work_order.`,
  };
}

/** WRITE. Approve a drafted additional work order (body: work_order_id, expected_updated_at). */
export async function approveAdditionalWorkOrderAction(
  client: any,
  body: any,
  auth: AdditionalWorkOrderAuth,
): Promise<Record<string, unknown>> {
  const id = text(body?.work_order_id);
  if (!UUID_RE.test(id)) fail("work_order_id_required", "work_order_id must be a work order UUID.");
  const expected = text(body?.expected_updated_at);
  if (!expected) fail("expected_updated_at_required", "Send the draft's updated_at as read (expected_updated_at).");
  const approver = await resolveApprover(client, auth, body);
  const { data: row, error: readError } = await client.from("work_orders").select(ROW_COLUMNS)
    .eq("id", id).eq("kind", "additional").maybeSingle();
  if (readError) fail("work_order_unreadable", "The work order could not be read.", 503);
  if (!row || (auth.orgId && row.org_id !== auth.orgId)) fail("work_order_not_found", "No additional work order matched.", 404);
  const { data, error } = await client.rpc("approve_additional_work_order", {
    p_work_order_id: id,
    p_approver: approver.userId,
    p_via: approver.via,
    p_expected_updated_at: expected,
    p_org_id: row.org_id,
  });
  if (error) {
    const message = text(error.message);
    if (/WO409|changed after it was read/i.test(`${error.code} ${message}`)) fail("stale_review", "The draft changed after it was read. Read it again before approving.", 409);
    fail("work_order_not_approved", message || "The work order was not approved.", 409);
  }
  return { success: true, work_order: data };
}

// ── Office: every work order on a job ────────────────────────────────────────

/** READ (staff). The job's main and additional work orders with their amounts. */
export async function listJobWorkOrdersAction(
  client: any,
  params: URLSearchParams,
  orgId: string | null,
): Promise<Record<string, unknown>> {
  const job = await readJobByRef(client, { job_id: params.get("job_id"), job_number: params.get("job_number") }, orgId);
  const rows = await readJobWorkOrderRows(client, job.id);
  const approved = rows.filter((r) => r.status === "approved" && r.agreed_labour_ex != null);
  return {
    schema: ADDITIONAL_WORK_ORDER_SCHEMA,
    job: { id: job.id, job_number: job.job_number, type: job.type, status: job.status },
    work_orders: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      main: r.kind === "job",
      wo_number: r.wo_number,
      title: r.title ?? (r.kind === "job" ? "Main work order" : null),
      status: r.status,
      agreed_labour_ex: r.agreed_labour_ex == null ? null : money(Number(r.agreed_labour_ex)),
      assigned_user_id: r.assigned_user_id ?? null,
      trade_name: r.trade_name ?? null,
      scheduled_date: r.scheduled_date ?? null,
      approved_at: r.approved_at ?? null,
      approved_via: r.approved_via ?? null,
      updated_at: r.updated_at,
    })),
    agreed_total_ex: money(approved.reduce((s, r) => s + Number(r.agreed_labour_ex), 0)),
  };
}
