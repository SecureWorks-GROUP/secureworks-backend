// deno-lint-ignore-file no-explicit-any
// Customer variations on a job work order (captain, 12 and 13 Oct 2026).
// Schema, seal and approval: 20261013140000_work_order_customer_variations.sql.
// Screen contract: docs/job-work-orders-v1.md ("Customer variations").
//
// The office records a variation the customer agreed to on a fencing or patio
// job: what it is, its tasks with the hours each takes, the labour allowed to
// the trades (trade_allocation_ex) and the customer's price (customer_price_ex),
// both ex GST. A draft is edited freely by staff, each edit naming the
// updated_at it read. A work order approver (work_order_settings, the same
// people who approve the work order) approves it: it joins the job's approved
// work order as the next numbered addendum and is sealed. A draft can be
// cancelled. The trade-reported variation (work_order_variations, the trade's
// overrun flag) is a different record and is untouched.
//
//   Staff (ops key or staff session):
//     create_customer_variation   POST  a new draft on a job
//     update_customer_variation   POST  edits a draft (expected_updated_at)
//     approve_customer_variation  POST  approver only; seals the draft as read
//     cancel_customer_variation   POST  cancels a draft (expected_updated_at)
//     customer_variations         GET   a job's customer variations
//     prepare_customer_variation_invoice_line POST  the customer invoice line,
//                                       built from the approved record; writes
//                                       nothing to Xero
//     create_customer_variation_xero_draft POST  a Xero DRAFT holding that
//                                       line; refused while feature flag
//                                       customer_variation_xero_draft_v1 is off
//     reconcile_customer_variation_xero_draft POST  approver only; after
//                                       checking Xero by hand, records the
//                                       draft that exists or releases a stuck
//                                       record to `prepared`; never calls Xero
//
// job_events rows written here carry ids only, never an amount: job_events is
// readable by every signed-in user of the org, trades included.

import {
  CUSTOMER_VARIATION_COLUMNS,
  customerVariationLabel,
  JOB_WORK_ORDER_JOB_TYPES,
  JobWorkOrderError,
  readFlag,
  readWorkOrderApprovers,
  shapeCustomerVariation,
  WORK_ORDER_TERMINAL_APPROVAL_FLAG,
  type WorkOrderApprover,
} from "./job_work_orders.ts";

export const CUSTOMER_VARIATION_SCHEMA = "customer-variations.v1";
/** Off: create_customer_variation_xero_draft writes nothing to Xero. */
export const CUSTOMER_VARIATION_XERO_DRAFT_FLAG =
  "customer_variation_xero_draft_v1";

export const MAX_CUSTOMER_VARIATION_TASKS = 50;
const MAX_DESCRIPTION = 2000;
const MAX_TASK_TEXT = 500;
const MAX_UNIT = 20;
const MAX_HOURS = 1000;
const MAX_MONEY = 10_000_000;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(status: number, code: string, message: string): never {
  throw new JobWorkOrderError(status, code, message);
}

function money(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    fail(400, "invalid_request", `${field} is required`);
  }
  return value;
}

// ── Pure: validation ─────────────────────────────────────────────────────────

// Trades read the description and every task through the shared money filter,
// which withholds a whole line that carries a price. A dollar sign is refused
// here so the office never records a line the trades cannot read.
function refuseMoneyText(value: string, field: string) {
  if (value.includes("$")) {
    fail(
      400,
      "money_in_text",
      `${field} is read by the trades: leave prices out of it (it may not contain $)`,
    );
  }
}

function parseText(value: unknown, field: string, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > max) {
    fail(400, `invalid_${field}`, `${field} must be 1 to ${max} characters`);
  }
  refuseMoneyText(text, field);
  return text;
}

function parseMoney(value: unknown, field: string): number | null {
  if (value === null) return null;
  const n = typeof value === "number" ? value : NaN;
  if (!Number.isFinite(n) || n < 0 || n > MAX_MONEY) {
    fail(
      400,
      `invalid_${field}`,
      `${field} must be a dollar amount of zero or more (ex GST), or null`,
    );
  }
  return money(n);
}

/** The tasks, each with its hours. Unknown keys are not stored. */
export function parseCustomerVariationTasks(value: unknown) {
  if (!Array.isArray(value) || value.length > MAX_CUSTOMER_VARIATION_TASKS) {
    fail(
      400,
      "invalid_tasks",
      `tasks must be a list of at most ${MAX_CUSTOMER_VARIATION_TASKS} tasks`,
    );
  }
  return value.map((task: any, i: number) => {
    if (!task || typeof task !== "object" || Array.isArray(task)) {
      fail(400, "invalid_tasks", `tasks[${i}] must be an object`);
    }
    const description = parseText(
      task.description,
      `tasks[${i}].description`,
      MAX_TASK_TEXT,
    );
    const hours = task.hours;
    if (
      typeof hours !== "number" || !Number.isFinite(hours) || hours <= 0 ||
      hours > MAX_HOURS
    ) {
      fail(
        400,
        "invalid_tasks",
        `tasks[${i}].hours must be the hours the task takes (more than 0, at most ${MAX_HOURS})`,
      );
    }
    const out: Record<string, unknown> = {
      description,
      hours: Math.round(hours * 100) / 100,
    };
    const hasQty = task.qty !== undefined && task.qty !== null;
    const hasUnit = task.unit !== undefined && task.unit !== null &&
      task.unit !== "";
    if (hasQty || hasUnit) {
      const qty = task.qty;
      const unit = typeof task.unit === "string" ? task.unit.trim() : "";
      if (
        typeof qty !== "number" || !Number.isFinite(qty) || qty <= 0 ||
        !unit || unit.length > MAX_UNIT
      ) {
        fail(
          400,
          "invalid_tasks",
          `tasks[${i}] gives a quantity with its unit (for example 6 and "m"), or neither`,
        );
      }
      refuseMoneyText(unit, `tasks[${i}].unit`);
      out.qty = Math.round(qty * 100) / 100;
      out.unit = unit;
    }
    return out;
  });
}

/**
 * The fields of a create or an edit. On create the description is required;
 * on an edit only the fields sent change, and at least one must be sent.
 */
export function validateCustomerVariationFields(
  body: any,
  opts: { create: boolean },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (opts.create || body?.description !== undefined) {
    out.description = parseText(
      body?.description,
      "description",
      MAX_DESCRIPTION,
    );
  }
  if (body?.tasks !== undefined) {
    out.tasks = parseCustomerVariationTasks(body.tasks);
  }
  for (const field of ["trade_allocation_ex", "customer_price_ex"]) {
    if (body?.[field] !== undefined) {
      out[field] = parseMoney(body[field], field);
    }
  }
  return out;
}

// ── Pure: the customer invoice line ──────────────────────────────────────────

export type CustomerVariationInvoiceLine = {
  description: string;
  quantity: number;
  unit_price: number;
  account_code: string;
};

/**
 * The customer's invoice line for an approved variation, in
 * create_invoice_draft's line shape: one line, quantity 1, the customer price
 * ex GST, the job's sales account. Its words name the variation and list the
 * tasks; the hours, the trade allocation and any rate stay off it.
 */
export function buildCustomerVariationInvoiceLine(
  variation: any,
  accountCode: string,
): CustomerVariationInvoiceLine {
  const label = customerVariationLabel(
    variation.variation_number,
    variation.approved_at,
  );
  const tasks = (Array.isArray(variation.tasks) ? variation.tasks : [])
    .map((t: any) => String(t?.description || "").trim())
    .filter(Boolean);
  const description = [
    `${label}: ${String(variation.description || "").trim()}`,
    ...tasks.map((t: string) => `- ${t}`),
  ].join("\n");
  return {
    description,
    quantity: 1,
    unit_price: money(variation.customer_price_ex),
    account_code: accountCode,
  };
}

// ── IO helpers ───────────────────────────────────────────────────────────────

const JOB_COLUMNS = "id, org_id, job_number, type, status, client_name";
const INVOICE_COLUMNS =
  "id, variation_id, job_id, line, status, prepared_by, prepared_at, xero_contact_id, job_contact_id, xero_requested_by, xero_requested_at, xero_invoice_id, invoice_number, xero_created_at, failure, updated_at";

async function readJob(client: any, jobId: string) {
  const { data, error } = await client.from("jobs").select(JOB_COLUMNS)
    .eq("id", jobId).maybeSingle();
  if (error) fail(500, "job_unreadable", "The job could not be read");
  if (!data) fail(404, "job_not_found", "Job not found");
  return data;
}

async function readVariation(client: any, id: string) {
  const { data, error } = await client.from("work_order_customer_variations")
    .select(CUSTOMER_VARIATION_COLUMNS).eq("id", id).maybeSingle();
  if (error) {
    fail(
      500,
      "customer_variation_unreadable",
      "The variation could not be read",
    );
  }
  if (!data) fail(404, "customer_variation_not_found", "Variation not found");
  return data;
}

async function readInvoiceRow(client: any, variationId: string) {
  const { data, error } = await client.from(
    "work_order_customer_variation_invoices",
  ).select(INVOICE_COLUMNS).eq("variation_id", variationId).maybeSingle();
  if (error) {
    fail(
      500,
      "customer_variation_invoice_unreadable",
      "The variation's invoice line could not be read",
    );
  }
  return data ?? null;
}

function requireActor(actor: { actor: string; missing: boolean }): string {
  if (actor.missing) {
    fail(
      403,
      "actor_identity_missing",
      "A customer variation records who wrote it. Sign in, or name the caller with x-sw-actor on a server key call.",
    );
  }
  return actor.actor;
}

function requireExpected(
  body: any,
  message =
    "Read the variation again and send its updated_at as expected_updated_at.",
): string {
  const expected = body?.expected_updated_at;
  if (typeof expected !== "string" || !Number.isFinite(Date.parse(expected))) {
    fail(400, "expected_updated_at_required", message);
  }
  return expected;
}

function actorUserId(actor: string): string | null {
  const m = /^user:([0-9a-f-]{36})$/i.exec(actor);
  return m && UUID_RE.test(m[1]) ? m[1] : null;
}

async function logJobEvent(
  client: any,
  jobId: string,
  eventType: string,
  detail: Record<string, unknown>,
  userId: string | null,
) {
  try {
    const { error } = await client.from("job_events").insert({
      job_id: jobId,
      event_type: eventType,
      user_id: userId,
      detail_json: detail,
    });
    if (error) {
      console.error(
        `[customer-variations] ${eventType} event not logged:`,
        error.message,
      );
    }
  } catch (e) {
    console.error(
      `[customer-variations] ${eventType} event not logged:`,
      (e as Error)?.message,
    );
  }
}

/**
 * After a compare-and-set that changed no row: say why, from the row as it is.
 */
async function explainMissedDraftWrite(
  client: any,
  id: string,
): Promise<never> {
  const current = await readVariation(client, id);
  if (current.status !== "draft") {
    fail(
      409,
      "variation_sealed",
      `This variation is ${current.status}: it can no longer change. Record a further variation instead.`,
    );
  }
  fail(
    409,
    "stale_review",
    "The variation changed after it was read. Read it again.",
  );
}

// ── Staff: record, edit, cancel ──────────────────────────────────────────────

export async function createCustomerVariation(
  client: any,
  body: any,
  actor: { actor: string; missing: boolean },
) {
  const jobId = requireUuid(body?.job_id, "job_id");
  const author = requireActor(actor);
  const fields = validateCustomerVariationFields(body, { create: true });
  const job = await readJob(client, jobId);
  if (!JOB_WORK_ORDER_JOB_TYPES.has(String(job.type || ""))) {
    fail(
      422,
      "job_type_not_eligible",
      "Customer variations on a work order are for fencing and patio jobs",
    );
  }
  const { data, error } = await client.from("work_order_customer_variations")
    .insert({
      org_id: job.org_id,
      job_id: jobId,
      tasks: [],
      ...fields,
      created_by: author,
    })
    .select(CUSTOMER_VARIATION_COLUMNS).single();
  if (error || !data) {
    fail(
      500,
      "customer_variation_not_saved",
      "The variation could not be saved",
    );
  }
  await logJobEvent(client, jobId, "customer_variation_recorded", {
    customer_variation_id: data.id,
  }, actorUserId(author));
  return { customer_variation: shapeCustomerVariation(data) };
}

export async function updateCustomerVariation(
  client: any,
  body: any,
  actor: { actor: string; missing: boolean },
) {
  const id = requireUuid(body?.variation_id, "variation_id");
  const author = requireActor(actor);
  const expected = requireExpected(body);
  const patch = validateCustomerVariationFields(body, { create: false });
  if (Object.keys(patch).length === 0) {
    fail(400, "nothing_to_update", "No editable field was given");
  }
  const { data, error } = await client.from("work_order_customer_variations")
    .update(patch)
    .eq("id", id).eq("status", "draft").eq("updated_at", expected)
    .select(CUSTOMER_VARIATION_COLUMNS).maybeSingle();
  if (error) {
    fail(
      500,
      "customer_variation_not_saved",
      "The variation could not be saved",
    );
  }
  if (!data) await explainMissedDraftWrite(client, id);
  await logJobEvent(client, data.job_id, "customer_variation_updated", {
    customer_variation_id: id,
  }, actorUserId(author));
  return { customer_variation: shapeCustomerVariation(data) };
}

export async function cancelCustomerVariation(
  client: any,
  body: any,
  actor: { actor: string; missing: boolean },
) {
  const id = requireUuid(body?.variation_id, "variation_id");
  const author = requireActor(actor);
  const expected = requireExpected(body);
  let reason: string | null = null;
  if (body?.reason !== undefined && body.reason !== null) {
    if (typeof body.reason !== "string" || body.reason.length > 2000) {
      fail(
        400,
        "invalid_reason",
        "reason must be text of at most 2000 characters",
      );
    }
    reason = body.reason.trim() || null;
  }
  const { data, error } = await client.from("work_order_customer_variations")
    .update({
      status: "cancelled",
      cancelled_by: author,
      cancel_reason: reason,
    })
    .eq("id", id).eq("status", "draft").eq("updated_at", expected)
    .select(CUSTOMER_VARIATION_COLUMNS).maybeSingle();
  if (error) {
    fail(
      500,
      "customer_variation_not_cancelled",
      "The variation could not be cancelled",
    );
  }
  if (!data) await explainMissedDraftWrite(client, id);
  await logJobEvent(client, data.job_id, "customer_variation_cancelled", {
    customer_variation_id: id,
  }, actorUserId(author));
  return { customer_variation: shapeCustomerVariation(data) };
}

// ── Staff: approve (work order approvers only) ───────────────────────────────

const APPROVE_ERRORS: Record<string, [number, string]> = {
  "42501": [403, "approver_required"],
  "23514": [422, "variation_not_ready"],
  "P0002": [404, "customer_variation_not_found"],
  "WO409": [409, "stale_review"],
  "WO422": [409, "work_order_not_approved"],
};

/**
 * The approval's permission: the caller is a work order approver
 * (work_order_settings), signed in, or named on a server key call while
 * feature flag work_order_terminal_approval_v1 is on. The same people decide
 * a customer variation's stuck Xero draft record.
 */
async function requireWorkOrderApprover(
  client: any,
  approver: WorkOrderApprover | null,
  words: { missing: string; terminalOff: string; notApprover: string },
): Promise<WorkOrderApprover> {
  if (!approver) fail(403, "approver_identity_missing", words.missing);
  if (
    approver.via === "terminal" &&
    !(await readFlag(client, WORK_ORDER_TERMINAL_APPROVAL_FLAG))
  ) {
    fail(403, "terminal_approval_switched_off", words.terminalOff);
  }
  const approvers = await readWorkOrderApprovers(client);
  if (approvers.length === 0) {
    fail(
      403,
      "approver_not_set",
      "No work order approver is named, so nobody can approve",
    );
  }
  if (!approvers.includes(approver.userId.toLowerCase())) {
    fail(403, "approver_required", words.notApprover);
  }
  return approver;
}

export async function approveCustomerVariation(
  client: any,
  body: any,
  approverIn: WorkOrderApprover | null,
) {
  const id = requireUuid(body?.variation_id, "variation_id");
  const approver = await requireWorkOrderApprover(client, approverIn, {
    missing: "Approving needs the work order approver's own signed-in session.",
    terminalOff:
      "Approving from the terminal is switched off (feature flag work_order_terminal_approval_v1). Approve from a signed-in session.",
    notApprover: "Only the work order approver approves a customer variation",
  });
  const expected = requireExpected(body);
  const current = await readVariation(client, id);
  if (current.status !== "draft") {
    fail(409, "not_a_draft", `This variation is ${current.status}`);
  }
  const { data, error } = await client.rpc(
    "approve_work_order_customer_variation",
    {
      p_variation_id: id,
      p_approver: approver.userId,
      p_via: approver.via,
      p_expected_updated_at: expected,
    },
  );
  if (error) {
    const mapped = APPROVE_ERRORS[String(error.code || "")];
    if (mapped) {
      fail(mapped[0], mapped[1], String(error.message || "Approval refused"));
    }
    fail(500, "approval_failed", "The variation could not be approved");
  }
  await logJobEvent(client, current.job_id, "customer_variation_approved", {
    customer_variation_id: id,
    work_order_id: data?.work_order_id ?? null,
    variation_number: data?.variation_number ?? null,
    approved_by: approver.userId,
    via: approver.via,
  }, approver.userId);
  return { customer_variation: shapeCustomerVariation(data) };
}

// ── Staff: read a job's customer variations ──────────────────────────────────

function shapeInvoiceRow(row: any) {
  if (!row) return null;
  return {
    status: row.status,
    line: row.line,
    prepared_by: row.prepared_by,
    prepared_at: row.prepared_at,
    xero_contact_id: row.xero_contact_id ?? null,
    job_contact_id: row.job_contact_id ?? null,
    xero_requested_by: row.xero_requested_by ?? null,
    xero_requested_at: row.xero_requested_at ?? null,
    xero_invoice_id: row.xero_invoice_id ?? null,
    invoice_number: row.invoice_number ?? null,
    xero_created_at: row.xero_created_at ?? null,
    failure: row.failure ?? null,
    updated_at: row.updated_at ?? null,
  };
}

export async function listCustomerVariations(client: any, jobIdRaw: unknown) {
  const jobId = requireUuid(jobIdRaw, "job_id");
  const job = await readJob(client, jobId);
  const { data, error } = await client.from("work_order_customer_variations")
    .select(CUSTOMER_VARIATION_COLUMNS).eq("job_id", jobId)
    .order("created_at", { ascending: true });
  if (error) {
    fail(
      500,
      "customer_variations_unreadable",
      "Customer variations could not be read",
    );
  }
  const rows = data || [];
  const ids = rows.map((r: any) => r.id);
  const invoices = new Map<string, any>();
  if (ids.length > 0) {
    const { data: inv, error: invErr } = await client.from(
      "work_order_customer_variation_invoices",
    ).select(INVOICE_COLUMNS).in("variation_id", ids);
    if (invErr) {
      fail(
        500,
        "customer_variation_invoice_unreadable",
        "The variations' invoice lines could not be read",
      );
    }
    for (const row of inv || []) invoices.set(row.variation_id, row);
  }
  return {
    schema: CUSTOMER_VARIATION_SCHEMA,
    job: { id: job.id, job_number: job.job_number, type: job.type },
    customer_variations: rows.map((r: any) => ({
      ...shapeCustomerVariation(r),
      invoice: shapeInvoiceRow(invoices.get(r.id)),
    })),
  };
}

// ── Staff: the customer invoice line (no Xero write) ─────────────────────────

export type CustomerVariationInvoiceDeps = {
  /** index.ts accountCodeForJob: the job type's sales account. */
  accountCodeForJob: (jobType: string) => string;
};

function draftBodyFor(job: any, variation: any, line: any) {
  return {
    job_id: job.id,
    line_items: [line],
    reference: `${job.job_number || ""} Variation ${variation.variation_number}`
      .trim(),
  };
}

/**
 * Builds the customer's invoice line from the approved variation and keeps it
 * on the variation's invoice record. Writes nothing to Xero. Once a Xero draft
 * holds the line (or one is being made), the kept line is returned unchanged.
 * The response carries `create_invoice_draft`: the job, the line and a
 * reference, ready for create_invoice_draft once the office picks the Xero
 * contact.
 */
export async function prepareCustomerVariationInvoiceLine(
  client: any,
  body: any,
  actor: { actor: string; missing: boolean },
  deps: CustomerVariationInvoiceDeps,
) {
  const id = requireUuid(body?.variation_id, "variation_id");
  const author = requireActor(actor);
  const variation = await readVariation(client, id);
  if (variation.status !== "approved") {
    fail(
      409,
      "variation_not_approved",
      "Only an approved variation has a customer invoice line",
    );
  }
  if (!(money(variation.customer_price_ex) > 0)) {
    fail(
      422,
      "no_customer_charge",
      "This variation charges the customer nothing, so it has no invoice line",
    );
  }
  const job = await readJob(client, variation.job_id);
  const line = buildCustomerVariationInvoiceLine(
    variation,
    deps.accountCodeForJob(String(job.type || "")),
  );
  let row = await readInvoiceRow(client, id);
  if (!row) {
    const { data, error } = await client.from(
      "work_order_customer_variation_invoices",
    ).insert({
      variation_id: id,
      job_id: variation.job_id,
      line,
      status: "prepared",
      prepared_by: author,
    }).select(INVOICE_COLUMNS).single();
    if (error?.code === "23505") {
      row = await readInvoiceRow(client, id);
    } else if (error || !data) {
      fail(
        500,
        "invoice_line_not_saved",
        "The invoice line could not be saved",
      );
    } else {
      row = data;
    }
  } else if (
    row.status === "prepared" &&
    JSON.stringify(row.line) !== JSON.stringify(line)
  ) {
    const { data, error } = await client.from(
      "work_order_customer_variation_invoices",
    ).update({ line, prepared_by: author })
      .eq("id", row.id).eq("status", "prepared")
      .select(INVOICE_COLUMNS).maybeSingle();
    if (error) {
      fail(
        500,
        "invoice_line_not_saved",
        "The invoice line could not be saved",
      );
    }
    row = data ?? await readInvoiceRow(client, id);
  }
  await logJobEvent(
    client,
    variation.job_id,
    "customer_variation_invoice_line_prepared",
    {
      customer_variation_id: id,
    },
    actorUserId(author),
  );
  return {
    customer_variation_id: id,
    line: row?.line ?? line,
    invoice: shapeInvoiceRow(row),
    create_invoice_draft: draftBodyFor(job, variation, row?.line ?? line),
    xero_draft_switched_on: await readFlag(
      client,
      CUSTOMER_VARIATION_XERO_DRAFT_FLAG,
    ),
  };
}

// ── Staff: a Xero DRAFT holding the line (switched off) ──────────────────────

/** index.ts createInvoiceDraftAction with the caller's own credentials. */
export type CustomerVariationDraftCreator = (
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/**
 * What create_invoice_draft throws before it asks Xero for anything: bad
 * input, the synthetic live-fire refusal, the preflight refusal and a Xero
 * token it could not get. Nothing exists in Xero after one of these.
 */
const REFUSED_BEFORE_XERO_MESSAGES = [
  /^line_items required$/,
  /^contact_name or xero_contact_id required$/,
  /^synthetic_livefire_release_forbidden:/,
  /synthetic live-fire safety gate could not verify/,
  /^No Xero token available\b/,
  /^Xero token refresh failed:/,
];

export function customerVariationDraftRefusedBeforeXero(
  result: Record<string, unknown> | null,
  thrown: any,
): boolean {
  if (result) {
    return result.ok === false &&
      result.code !== "INVOICE_DRAFT_OUTCOME_UNCONFIRMED";
  }
  if (thrown?.code === "PREFLIGHT_FAILED") return true;
  const message = String(thrown?.message ?? "");
  return REFUSED_BEFORE_XERO_MESSAGES.some((re) => re.test(message));
}

/**
 * Creates one Xero DRAFT customer invoice (ACCREC, never sent) holding the
 * variation's line, through create_invoice_draft's own path and gates. Refused
 * while feature flag customer_variation_xero_draft_v1 is off. One draft per
 * variation: the invoice record is claimed (prepared -> creating) before the
 * call. A refusal create_invoice_draft gives before Xero is called
 * (customerVariationDraftRefusedBeforeXero) releases the claim; any other
 * outcome Xero did not confirm is kept as `unknown` and never retried here,
 * because the draft may exist. A confirmed draft whose outcome could not be
 * saved is reported as a failure naming the Xero invoice, never as success.
 */
export async function createCustomerVariationXeroDraft(
  client: any,
  body: any,
  actor: { actor: string; missing: boolean },
  deps: CustomerVariationInvoiceDeps & {
    createDraft: CustomerVariationDraftCreator;
  },
) {
  const id = requireUuid(body?.variation_id, "variation_id");
  const author = requireActor(actor);
  if (!(await readFlag(client, CUSTOMER_VARIATION_XERO_DRAFT_FLAG))) {
    fail(
      403,
      "xero_draft_switched_off",
      "Creating the Xero draft for a variation is switched off (feature flag customer_variation_xero_draft_v1). Use the prepared line.",
    );
  }
  const xeroContactId = requireUuid(body?.xero_contact_id, "xero_contact_id");
  const jobContactId = body?.job_contact_id === undefined ||
      body?.job_contact_id === null
    ? null
    : requireUuid(body.job_contact_id, "job_contact_id");

  const prepared = await prepareCustomerVariationInvoiceLine(
    client,
    { variation_id: id },
    actor,
    deps,
  );
  const current = await readInvoiceRow(client, id);
  if (current?.status === "xero_draft_created") {
    return { ...prepared, duplicate: true };
  }
  const { data: claimed, error: claimErr } = await client.from(
    "work_order_customer_variation_invoices",
  ).update({
    status: "creating",
    xero_contact_id: xeroContactId,
    job_contact_id: jobContactId,
    xero_requested_by: author,
    xero_requested_at: new Date().toISOString(),
    failure: null,
  }).eq("variation_id", id).eq("status", "prepared")
    .select(INVOICE_COLUMNS).maybeSingle();
  if (claimErr) {
    fail(
      500,
      "invoice_line_not_claimed",
      "The invoice line could not be claimed",
    );
  }
  if (!claimed) {
    const now = await readInvoiceRow(client, id);
    if (now?.status === "xero_draft_created") {
      return { ...prepared, invoice: shapeInvoiceRow(now), duplicate: true };
    }
    fail(
      409,
      now?.status === "unknown"
        ? "xero_outcome_unknown"
        : "xero_draft_in_progress",
      now?.status === "unknown"
        ? "A Xero draft for this variation was requested and Xero did not confirm it. Check Xero, then a work order approver records the draft or releases the line (reconcile_customer_variation_xero_draft)."
        : "A Xero draft for this variation is being created. If it stays that way, a work order approver checks Xero and answers for it (reconcile_customer_variation_xero_draft).",
    );
  }

  const payload = {
    ...prepared.create_invoice_draft,
    xero_contact_id: xeroContactId,
    ...(jobContactId ? { job_contact_id: jobContactId } : {}),
  };
  let result: Record<string, unknown> | null = null;
  let thrown: any = null;
  try {
    result = await deps.createDraft(payload);
  } catch (e) {
    thrown = e;
  }
  const xeroInvoiceId = String(result?.xero_invoice_id || "").trim();
  let patch: Record<string, unknown>;
  if (result?.ok === true && xeroInvoiceId) {
    patch = {
      status: "xero_draft_created",
      xero_invoice_id: xeroInvoiceId,
      invoice_number: result.invoice_number ?? null,
      xero_created_at: new Date().toISOString(),
    };
  } else if (customerVariationDraftRefusedBeforeXero(result, thrown)) {
    // Refused before Xero was called: nothing exists, the line can go again.
    patch = {
      status: "prepared",
      failure: String(
        result?.error || result?.code || thrown?.message ||
          "refused",
      ).slice(0, 500),
    };
  } else {
    patch = {
      status: "unknown",
      failure: String(
        result?.error || result?.code || thrown?.message ||
          "outcome not confirmed",
      ).slice(0, 500),
    };
  }
  const { data: saved, error: saveErr } = await client.from(
    "work_order_customer_variation_invoices",
  ).update(patch).eq("variation_id", id).eq("status", "creating")
    .select(INVOICE_COLUMNS).maybeSingle();
  if (saveErr || !saved) {
    console.error(
      "[customer-variations] Xero draft outcome not saved:",
      id,
      saveErr?.message,
    );
  }
  if (patch.status === "xero_draft_created") {
    await logJobEvent(
      client,
      prepared.create_invoice_draft.job_id,
      "customer_variation_xero_draft_created",
      {
        customer_variation_id: id,
        xero_invoice_id: xeroInvoiceId,
      },
      actorUserId(author),
    );
    if (saveErr || !saved) {
      throw new JobWorkOrderError(
        502,
        "xero_draft_outcome_not_saved",
        `Xero created draft invoice ${
          String(patch.invoice_number ?? "(no number)")
        } (Xero invoice id ${xeroInvoiceId}) but this variation's record of it was not saved. Check that invoice in Xero, then a work order approver records it (reconcile_customer_variation_xero_draft).`,
      );
    }
  }
  const invoice = shapeInvoiceRow(saved ?? { ...claimed, ...patch });
  if (patch.status !== "xero_draft_created") {
    const status = patch.status === "unknown" ? 502 : 422;
    throw new JobWorkOrderError(
      status,
      patch.status === "unknown"
        ? "xero_outcome_unknown"
        : "xero_draft_refused",
      `${String(patch.failure)}${
        patch.status === "unknown"
          ? " Check Xero before doing anything else: the draft may exist. Then a work order approver records it or releases the line (reconcile_customer_variation_xero_draft)."
          : ""
      }`,
    );
  }
  return { ...prepared, invoice, duplicate: false };
}

// ── Approver: answer for a stuck Xero draft record (never calls Xero) ───────

/**
 * A `creating` claim younger than this may still have its create_invoice_draft
 * call running, so it is not answered for. An ops-api request cannot outlive
 * the edge worker's wall-clock limit (400 seconds), so an older claim has no
 * request left that could still finish it.
 */
export const CUSTOMER_VARIATION_CREATING_STALE_AFTER_MS = 15 * 60 * 1000;

const XERO_DRAFT_OUTCOMES = new Set(["draft_exists", "no_draft"]);
const MAX_INVOICE_NUMBER = 50;

function parseReconcileBody(body: any) {
  const outcome = body?.outcome;
  if (typeof outcome !== "string" || !XERO_DRAFT_OUTCOMES.has(outcome)) {
    fail(
      400,
      "invalid_outcome",
      'outcome is "draft_exists" (you found the draft in Xero) or "no_draft" (you checked Xero and none was made)',
    );
  }
  if (outcome === "no_draft") {
    if (
      (body?.xero_invoice_id ?? null) !== null ||
      (body?.invoice_number ?? null) !== null
    ) {
      fail(
        400,
        "invalid_request",
        "no_draft releases the line: it takes no Xero invoice id or number",
      );
    }
    return { outcome, xeroInvoiceId: null, invoiceNumber: null };
  }
  const xeroInvoiceId = requireUuid(body?.xero_invoice_id, "xero_invoice_id")
    .toLowerCase();
  let invoiceNumber: string | null = null;
  if (body?.invoice_number !== undefined && body.invoice_number !== null) {
    const n = typeof body.invoice_number === "string"
      ? body.invoice_number.trim()
      : "";
    if (!n || n.length > MAX_INVOICE_NUMBER) {
      fail(
        400,
        "invalid_invoice_number",
        `invoice_number is the Xero invoice number as shown in Xero (at most ${MAX_INVOICE_NUMBER} characters)`,
      );
    }
    invoiceNumber = n;
  }
  return { outcome, xeroInvoiceId, invoiceNumber };
}

function creatingIsStale(row: any, nowMs: number): boolean {
  const requested = Date.parse(String(row?.xero_requested_at ?? ""));
  return Number.isFinite(requested) &&
    nowMs - requested >= CUSTOMER_VARIATION_CREATING_STALE_AFTER_MS;
}

function refuseUnreconcilable(row: any, nowMs: number): void {
  if (!row) {
    fail(
      404,
      "invoice_line_not_found",
      "This variation has no invoice record to answer for",
    );
  }
  if (row.status === "prepared") {
    fail(
      409,
      "nothing_to_reconcile",
      "This variation's line is prepared: no Xero draft is pending, so there is nothing to answer for",
    );
  }
  if (row.status === "xero_draft_created") {
    fail(
      409,
      "xero_draft_already_recorded",
      `This variation's Xero draft is already recorded (Xero invoice id ${row.xero_invoice_id}). Change it in Xero.`,
    );
  }
  if (row.status === "creating" && !creatingIsStale(row, nowMs)) {
    fail(
      409,
      "xero_draft_in_progress",
      `A Xero draft for this variation was requested at ${row.xero_requested_at} and may still be on its way. Wait ${
        CUSTOMER_VARIATION_CREATING_STALE_AFTER_MS / 60000
      } minutes from then, check Xero, and answer for it after that.`,
    );
  }
}

/**
 * A work order approver answers for a variation's Xero draft record that is
 * `unknown` (Xero did not confirm the create) or stuck in `creating` (older
 * than CUSTOMER_VARIATION_CREATING_STALE_AFTER_MS), after checking Xero by
 * hand. Never calls Xero.
 *
 *   outcome draft_exists  records the draft they found: xero_invoice_id (and
 *                         its invoice_number when given); the record becomes
 *                         `xero_draft_created` and is sealed like any other.
 *   outcome no_draft      releases the record to `prepared`, so the line can
 *                         be sent to Xero again.
 *
 * The caller names the record's updated_at as read (expected_updated_at); the
 * write is one compare-and-set on that, on the status read and, for
 * `creating`, on the claim still being older than the threshold. Who answered,
 * how, when and what is recorded in a job_events row.
 */
export async function reconcileCustomerVariationXeroDraft(
  client: any,
  body: any,
  approverIn: WorkOrderApprover | null,
  opts: { now?: () => number } = {},
) {
  const id = requireUuid(body?.variation_id, "variation_id");
  const approver = await requireWorkOrderApprover(client, approverIn, {
    missing:
      "Answering for a variation's Xero draft needs the work order approver's own signed-in session.",
    terminalOff:
      "Answering for a variation's Xero draft from the terminal is switched off (feature flag work_order_terminal_approval_v1). Use a signed-in session.",
    notApprover:
      "Only the work order approver answers for a variation's Xero draft",
  });
  const expected = requireExpected(
    body,
    "Read the variation again and send its Xero draft record's updated_at (invoice.updated_at) as expected_updated_at.",
  );
  const answer = parseReconcileBody(body);
  const nowMs = (opts.now ?? Date.now)();

  const variation = await readVariation(client, id);
  const row = await readInvoiceRow(client, id);
  if (
    row?.status === "xero_draft_created" &&
    answer.outcome === "draft_exists" &&
    String(row.xero_invoice_id || "").toLowerCase() === answer.xeroInvoiceId
  ) {
    return {
      customer_variation_id: id,
      invoice: shapeInvoiceRow(row),
      duplicate: true,
    };
  }
  refuseUnreconcilable(row, nowMs);

  if (answer.outcome === "draft_exists") {
    const { data: others, error: othersErr } = await client.from(
      "work_order_customer_variation_invoices",
    ).select("variation_id").eq("xero_invoice_id", answer.xeroInvoiceId);
    if (othersErr) {
      fail(
        500,
        "customer_variation_invoice_unreadable",
        "The variations' invoice records could not be read",
      );
    }
    if ((others || []).some((o: any) => o.variation_id !== id)) {
      fail(
        409,
        "xero_invoice_already_recorded",
        "That Xero invoice is already recorded for another variation. Check the invoice id in Xero.",
      );
    }
  }

  const nowIso = new Date(nowMs).toISOString();
  const patch = answer.outcome === "draft_exists"
    ? {
      status: "xero_draft_created",
      xero_invoice_id: answer.xeroInvoiceId,
      invoice_number: answer.invoiceNumber,
      xero_created_at: nowIso,
    }
    : {
      status: "prepared",
      xero_invoice_id: null,
      invoice_number: null,
      xero_created_at: null,
    };
  let write = client.from("work_order_customer_variation_invoices")
    .update(patch)
    .eq("variation_id", id).eq("status", row.status)
    .eq("updated_at", expected);
  if (row.status === "creating") {
    // The claim must still be the stale one read: a fresh claim made since
    // has its own xero_requested_at and is left alone.
    write = write.eq("xero_requested_at", row.xero_requested_at);
  }
  const { data: saved, error } = await write.select(INVOICE_COLUMNS)
    .maybeSingle();
  if (error) {
    fail(
      500,
      "invoice_record_not_saved",
      "The variation's Xero draft record could not be saved",
    );
  }
  if (!saved) {
    fail(
      409,
      "stale_review",
      "The variation's Xero draft record changed after it was read. Read the variation again and send its Xero draft record's updated_at (invoice.updated_at) as expected_updated_at.",
    );
  }
  await logJobEvent(
    client,
    variation.job_id,
    "customer_variation_xero_draft_reconciled",
    {
      customer_variation_id: id,
      outcome: answer.outcome,
      from_status: row.status,
      xero_invoice_id: answer.xeroInvoiceId,
      reconciled_by: approver.userId,
      via: approver.via,
    },
    approver.userId,
  );
  return {
    customer_variation_id: id,
    invoice: shapeInvoiceRow(saved),
    duplicate: false,
  };
}
