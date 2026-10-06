// deno-lint-ignore-file no-explicit-any
// Job work orders: one live work order per fencing and patio job (captain,
// 6 Oct 2026). Schema, seal, triggers and backfill:
// 20261006120000_job_work_orders.sql. Screen contract:
// docs/job-work-orders-v1.md.
//
// A job work order is a work_orders row with kind = 'job'. It is a draft
// (editable, counts for nothing) until an approver named in
// work_order_settings (seeded with Shaun's users.id) approves it. Approving
// seals it like an invoice: the database refuses any later edit, and change
// comes only through trade variations or a revision that supersedes it.
//
//   Staff (ops key or staff session):
//     job_work_order          GET   one job's work order, live figures, labour
//                                   lines, invoices and variations
//     list_work_orders        GET   kind=job lists job work orders with figures
//     create_work_order       POST  kind=job opens the job's draft, or a
//                                   revision draft of the live approved one
//     update_work_order       POST  edits a job DRAFT (approved ones are sealed)
//     approve_work_order      POST  approver only (see resolveWorkOrderApprover)
//     backfill_job_work_orders POST ops key only; dry run unless apply:true AND
//                                   feature flag job_work_order_backfill_v1 is on
//   Trade (signed-in Trade App user with access to the job):
//     my_job_work_order       GET   the approved work order's scope and agreed
//                                   details, every price and allowance left out
//     report_work_order_variation POST a variation on the trade's own invoice;
//                                   records the finance and admin emails, sent
//                                   only while work_order_variation_emails_v1 is on
//
// Labour billed against a work order is stamped by the database at invoice
// submit (trade_invoice_lines.job_work_order_id); this module only reads it.

export const JOB_WORK_ORDER_SCHEMA = "job-work-order.v1";
export const TRADE_JOB_WORK_ORDER_SCHEMA = "trade-job-work-order.v1";

export const JOB_WORK_ORDER_JOB_TYPES: ReadonlySet<string> = new Set([
  "fencing",
  "patio",
]);

/** Mirror of public.job_work_order_open_statuses(). */
export const JOB_WORK_ORDER_OPEN_STATUSES: readonly string[] = [
  "accepted",
  "partially_accepted",
  "approvals",
  "deposit",
  "awaiting_deposit",
  "processing",
  "order_materials",
  "awaiting_supplier",
  "order_confirmed",
  "schedule_install",
  "scheduled",
  "in_progress",
  "rectification",
];

/** Mirror of public.job_work_order_billed_invoice_statuses(). */
export const JOB_WORK_ORDER_BILLED_INVOICE_STATUSES: ReadonlySet<string> =
  new Set([
    "pending_acknowledgment",
    "queried",
    "acknowledged",
    "pending_ops_review",
    "approved",
    "pushed_to_xero",
    "paid",
  ]);

/** Mirror of public.job_work_order_excluded_line_types(). */
export const JOB_WORK_ORDER_EXCLUDED_LINE_TYPES: ReadonlySet<string> = new Set([
  "commission",
  "final_payout_deduction",
]);

// Recipients (secureworks-wiki harness/ops/sops/make-safe-ops-agent-sop.md:
// line 134 "From: admin@secureworkswa.com.au", the default operational
// mailbox; line 137 the finance department mailbox
// finance@secureworkswa.com.au; also ops-api/finance_review_email.ts).
export const WORK_ORDER_VARIATION_FINANCE_EMAIL =
  "finance@secureworkswa.com.au";
export const WORK_ORDER_VARIATION_ADMIN_EMAIL = "admin@secureworkswa.com.au";
export const WORK_ORDER_VARIATION_SENDER_MAILBOX = "admin@secureworkswa.com.au";
export const WORK_ORDER_VARIATION_EMAILS_FLAG =
  "work_order_variation_emails_v1";

/** Rule near_agreed fires at this share of the agreed labour. */
export const WORK_ORDER_NEAR_AGREED_RATIO = 0.9;

const MAX_SCOPE_ITEMS = 200;
const MAX_TEXT = 4000;
const MAX_VARIATION_TEXT = 2000;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class JobWorkOrderError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function fail(status: number, code: string, message: string): never {
  throw new JobWorkOrderError(status, code, message);
}

function money(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function requireUuid(value: unknown, field: string): string {
  if (!isUuid(value)) fail(400, "invalid_request", `${field} is required`);
  return value;
}

// ── Pure: who is approving ───────────────────────────────────────────────────

export type WorkOrderApprover = { userId: string; via: "session" | "terminal" };

/**
 * The human behind an approve call, or null.
 *   session   a verified staff JWT: the signed-in user.
 *   terminal  a server-secret call (SecureSuite) whose trusted x-sw-actor
 *             header names the user as `user:<users.id>`. The header is a
 *             claim made by a caller that already holds a server secret, the
 *             same trust the approved-send recorder relies on.
 * The shared browser key never counts (its header is untrusted upstream).
 * Being named is not enough: approveJobWorkOrder then requires the id to be on
 * work_order_settings.approver_user_ids, and the database checks it again.
 */
export function resolveWorkOrderApprover(input: {
  authMode: string;
  authUserId?: string | null;
  serverSecretPresented: boolean;
  actor?: { actor: string; source: string } | null;
}): WorkOrderApprover | null {
  if (input.authMode === "jwt") {
    return isUuid(input.authUserId)
      ? { userId: input.authUserId, via: "session" }
      : null;
  }
  if (
    input.authMode === "api_key" && input.serverSecretPresented &&
    input.actor?.source === "header"
  ) {
    const m = /^user:([0-9a-f-]{36})$/i.exec(input.actor.actor || "");
    if (m && isUuid(m[1])) {
      return { userId: m[1].toLowerCase(), via: "terminal" };
    }
  }
  return null;
}

// ── Pure: running figures and rules ──────────────────────────────────────────

export type WorkOrderLabourLine = {
  trade_invoice_line_id: string;
  trade_invoice_id: string;
  work_order_id: string | null;
  job_id: string;
  user_id: string | null;
  trade_name: string | null;
  invoice_number: string | null;
  invoice_status: string;
  submitted_at: string | null;
  line_type: string | null;
  description: string | null;
  hours: number | null;
  amount_ex: number;
  counted: boolean;
};

export type WorkOrderRule = {
  key:
    | "over_agreed"
    | "near_agreed"
    | "has_variations"
    | "no_approved_work_order";
  level: "flag" | "warn" | "info";
  message: string;
};

export type WorkOrderFigures = {
  agreed_ex: number | null;
  billed_to_date_ex: number;
  variations_ex: number;
  variation_count: number;
  billed_within_agreed_scope_ex: number;
  remaining_ex: number | null;
  used_ratio: number | null;
  over_agreed: boolean;
  rules: WorkOrderRule[];
};

/**
 * Live figures for the job's approved work order.
 *   billed_to_date_ex  every counted labour line stamped against an approved
 *                      job work order of this job (variation work included,
 *                      since the trade bills a variation on the same invoice).
 *   variations_ex      the part of billed the trades marked as variations.
 *   remaining_ex       agreed - billed_to_date.
 * Rules (named, in the PR and docs/job-work-orders-v1.md):
 *   over_agreed   flag  billed (within agreed scope + variations) > agreed
 *   near_agreed   warn  billed >= 90% of agreed and not over
 *   has_variations info at least one variation reported on the work order
 *   no_approved_work_order info nothing counts until a work order is approved
 */
export function computeWorkOrderFigures(input: {
  agreedEx: number | null;
  approved: boolean;
  lines: Array<
    Pick<WorkOrderLabourLine, "amount_ex" | "counted" | "work_order_id">
  >;
  variations: Array<
    { amount_ex: number | null; status: string; work_order_id: string | null }
  >;
}): WorkOrderFigures {
  const counted = input.lines.filter((l) => l.counted && l.work_order_id);
  const billed = money(counted.reduce((s, l) => s + money(l.amount_ex), 0));
  const liveVariations = input.variations.filter((v) =>
    v.status === "reported" && v.work_order_id
  );
  const variationsEx = money(
    liveVariations.reduce((s, v) => s + money(v.amount_ex ?? 0), 0),
  );
  const agreed = input.approved && input.agreedEx !== null &&
      input.agreedEx !== undefined
    ? money(input.agreedEx)
    : null;
  const rules: WorkOrderRule[] = [];
  let usedRatio: number | null = null;
  let over = false;
  if (!input.approved) {
    rules.push({
      key: "no_approved_work_order",
      level: "info",
      message: "No approved work order yet, so no labour counts against it.",
    });
  }
  if (agreed !== null) {
    usedRatio = agreed > 0
      ? Math.round((billed / agreed) * 10000) / 10000
      : (billed > 0 ? null : 0);
    over = billed > agreed;
    if (over) {
      rules.push({
        key: "over_agreed",
        level: "flag",
        message: `Billed $${billed.toFixed(2)} is over the agreed $${
          agreed.toFixed(2)
        }.`,
      });
    } else if (agreed > 0 && billed >= agreed * WORK_ORDER_NEAR_AGREED_RATIO) {
      rules.push({
        key: "near_agreed",
        level: "warn",
        message: `Billed $${billed.toFixed(2)} is ${
          Math.round((billed / agreed) * 100)
        }% of the agreed $${agreed.toFixed(2)}.`,
      });
    }
  }
  if (liveVariations.length > 0) {
    rules.push({
      key: "has_variations",
      level: "info",
      message: `${liveVariations.length} variation${
        liveVariations.length === 1 ? "" : "s"
      } reported.`,
    });
  }
  return {
    agreed_ex: agreed,
    billed_to_date_ex: billed,
    variations_ex: variationsEx,
    variation_count: liveVariations.length,
    billed_within_agreed_scope_ex: money(billed - variationsEx),
    remaining_ex: agreed === null ? null : money(agreed - billed),
    used_ratio: usedRatio,
    over_agreed: over,
    rules,
  };
}

// ── Pure: validation of draft edits ──────────────────────────────────────────

export const JOB_WORK_ORDER_DRAFT_FIELDS = [
  "scope_items",
  "special_instructions",
  "agreed_labour_ex",
  "scheduled_date",
  "site_address",
] as const;

export function validateJobWorkOrderDraftPatch(
  body: any,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (body?.scope_items !== undefined || body?.scopeItems !== undefined) {
    const items = body.scope_items ?? body.scopeItems;
    if (!Array.isArray(items) || items.length > MAX_SCOPE_ITEMS) {
      fail(
        400,
        "invalid_scope_items",
        `scope_items must be a list of at most ${MAX_SCOPE_ITEMS} items`,
      );
    }
    for (const item of items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        fail(400, "invalid_scope_items", "every scope item must be an object");
      }
    }
    out.scope_items = items;
  }
  const instructions = body?.special_instructions ?? body?.specialInstructions;
  if (instructions !== undefined) {
    if (
      instructions !== null &&
      (typeof instructions !== "string" || instructions.length > MAX_TEXT)
    ) {
      fail(
        400,
        "invalid_special_instructions",
        `special_instructions must be text of at most ${MAX_TEXT} characters`,
      );
    }
    out.special_instructions = instructions;
  }
  const agreed = body?.agreed_labour_ex ?? body?.agreedLabourEx;
  if (agreed !== undefined) {
    if (agreed !== null) {
      const n = Number(agreed);
      if (!Number.isFinite(n) || n < 0 || n > 10_000_000) {
        fail(
          400,
          "invalid_agreed_labour_ex",
          "agreed_labour_ex must be a dollar amount of zero or more",
        );
      }
      out.agreed_labour_ex = money(n);
    } else {
      out.agreed_labour_ex = null;
    }
  }
  const scheduled = body?.scheduled_date ?? body?.scheduledDate;
  if (scheduled !== undefined) {
    if (scheduled !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(scheduled))) {
      fail(400, "invalid_scheduled_date", "scheduled_date must be YYYY-MM-DD");
    }
    out.scheduled_date = scheduled;
  }
  const address = body?.site_address ?? body?.siteAddress;
  if (address !== undefined) {
    if (
      address !== null && (typeof address !== "string" || address.length > 500)
    ) {
      fail(400, "invalid_site_address", "site_address must be text");
    }
    out.site_address = address;
  }
  return out;
}

// ── Pure: trade projection (no prices, allowances or margins) ────────────────

export type TradeRedaction = {
  /** index.ts redactTradeWorkOrderScopeItems (allowlist-only). */
  scopeItems: (items: unknown) => unknown[];
  /** index.ts sanitizeTradeAllocatedStringLeaf (drops money language). */
  text: (value: string, key: string) => string;
};

/**
 * What a trade sees: scope and agreed details only. Built from an explicit
 * allowlist, so agreed_labour_ex, figures, billed amounts and any price on a
 * scope item can never reach it.
 */
export function projectTradeJobWorkOrder(
  wo: any,
  job: any,
  redact: TradeRedaction,
): Record<string, unknown> {
  const instructions = typeof wo?.special_instructions === "string"
    ? redact.text(wo.special_instructions, "special_instructions")
    : null;
  return {
    id: wo.id,
    wo_number: wo.wo_number,
    status: wo.status,
    approved_at: wo.approved_at || null,
    job_id: wo.job_id,
    job_number: job?.job_number || null,
    job_type: job?.type || null,
    site_address: wo.site_address ||
      [job?.site_address, job?.site_suburb].filter(Boolean).join(", ") || null,
    scheduled_date: wo.scheduled_date || null,
    scope_items: redact.scopeItems(
      Array.isArray(wo.scope_items) ? wo.scope_items : [],
    ),
    special_instructions: instructions || null,
  };
}

// ── Pure: variation emails ───────────────────────────────────────────────────

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Staff-facing text never carries an em or en dash. */
export function noDashes(value: string): string {
  return value.replace(new RegExp("[\\u2013\\u2014]", "g"), "-");
}

export type VariationEmailInput = {
  jobNumber: string | null;
  siteSuburb: string | null;
  woNumber: string | null;
  tradeName: string | null;
  invoiceNumber: string | null;
  description: string;
  amountEx: number | null;
  figures: WorkOrderFigures | null;
};

export type VariationEmail = {
  recipient_role: "finance" | "admin";
  recipient: string;
  subject: string;
  body_text: string;
  body_html: string;
};

export function buildVariationEmails(
  input: VariationEmailInput,
): VariationEmail[] {
  const job = input.jobNumber || "a job";
  const where = input.siteSuburb ? ` (${input.siteSuburb})` : "";
  const subject = noDashes(`Work order variation on ${job}${where}`);
  const facts: Array<[string, string]> = [
    ["Job", `${job}${where}`],
    ["Work order", input.woNumber || "No approved work order yet"],
    ["Trade", input.tradeName || "Unknown"],
    ["Trade invoice", input.invoiceNumber || "Not numbered yet"],
    ["Variation", input.description],
    [
      "Variation amount (ex GST)",
      input.amountEx === null
        ? "Not given"
        : `$${money(input.amountEx).toFixed(2)}`,
    ],
  ];
  if (input.figures && input.figures.agreed_ex !== null) {
    facts.push(
      ["Agreed labour (ex GST)", `$${input.figures.agreed_ex.toFixed(2)}`],
      [
        "Billed to date (ex GST)",
        `$${input.figures.billed_to_date_ex.toFixed(2)}`,
      ],
      [
        "Remaining (ex GST)",
        `$${(input.figures.remaining_ex ?? 0).toFixed(2)}`,
      ],
    );
    if (input.figures.over_agreed) {
      facts.push(["Flag", "Billed is over the agreed labour"]);
    }
  }
  const intros: Record<"finance" | "admin", string> = {
    finance:
      "A trade has reported a variation to the work order on their invoice. Please check it before the invoice is paid.",
    admin:
      "A trade has reported a variation to the work order on their invoice. Please update the job and follow up with the client if needed.",
  };
  const recipients: Array<["finance" | "admin", string]> = [
    ["finance", WORK_ORDER_VARIATION_FINANCE_EMAIL],
    ["admin", WORK_ORDER_VARIATION_ADMIN_EMAIL],
  ];
  return recipients.map(([role, recipient]) => {
    const text = noDashes([
      intros[role],
      "",
      ...facts.map(([k, v]) => `${k}: ${v}`),
      "",
      "SecureWorks Group",
    ].join("\n"));
    const html = noDashes(
      `<p>${
        esc(intros[role])
      }</p><table cellpadding="4" style="border-collapse:collapse">` +
        facts.map(([k, v]) =>
          `<tr><td><strong>${esc(k)}</strong></td><td>${esc(v)}</td></tr>`
        ).join("") +
        `</table><p>SecureWorks Group</p>`,
    );
    return {
      recipient_role: role,
      recipient,
      subject,
      body_text: text,
      body_html: html,
    };
  });
}

// ── IO helpers ───────────────────────────────────────────────────────────────

const JOB_COLUMNS =
  "id, org_id, job_number, client_name, type, status, site_address, site_suburb, work_order_id";
const WO_COLUMNS =
  "id, org_id, job_id, wo_number, kind, status, scope_items, special_instructions, scheduled_date, site_address, agreed_labour_ex, approved_at, approved_by, approved_via, sealed_content_hash, supersedes_work_order_id, superseded_at, superseded_by_work_order_id, origin, created_at, updated_at";

async function readJob(client: any, jobId: string) {
  const { data, error } = await client.from("jobs").select(JOB_COLUMNS).eq(
    "id",
    jobId,
  ).maybeSingle();
  if (error) fail(500, "job_unreadable", "The job could not be read");
  if (!data) fail(404, "job_not_found", "Job not found");
  return data;
}

async function readJobWorkOrders(client: any, jobId: string): Promise<any[]> {
  const { data, error } = await client.from("work_orders").select(WO_COLUMNS)
    .eq("job_id", jobId).eq("kind", "job").order("created_at", {
      ascending: true,
    });
  if (error) {
    fail(
      500,
      "work_orders_unreadable",
      "The job's work orders could not be read",
    );
  }
  return data || [];
}

async function readWorkOrder(client: any, id: string) {
  const { data, error } = await client.from("work_orders").select(WO_COLUMNS)
    .eq("id", id).maybeSingle();
  if (error) {
    fail(500, "work_order_unreadable", "The work order could not be read");
  }
  if (!data) fail(404, "work_order_not_found", "Work order not found");
  return data;
}

function liveOf(rows: any[]) {
  return rows.find((r) => r.status === "approved" && !r.superseded_at) || null;
}
function draftOf(rows: any[]) {
  return rows.find((r) => r.status === "draft") || null;
}

async function readLabourLines(
  client: any,
  jobIds: string[],
): Promise<WorkOrderLabourLine[]> {
  const out: WorkOrderLabourLine[] = [];
  for (let i = 0; i < jobIds.length; i += 25) {
    const chunk = jobIds.slice(i, i + 25);
    let offset = 0;
    while (true) {
      const { data, error } = await client.from("trade_invoice_lines")
        .select(
          "id, trade_invoice_id, job_id, job_work_order_id, line_type, description, total_hours, work_order_hours, line_total_ex, override_amount, trade_invoices!inner(id, user_id, invoice_number, status, submitted_at, users:user_id(name))",
        )
        .in("job_id", chunk)
        .order("id", { ascending: true })
        .range(offset, offset + 999);
      if (error) {
        fail(500, "labour_unreadable", "Trade labour could not be read");
      }
      for (const row of data || []) {
        const inv = Array.isArray(row.trade_invoices)
          ? row.trade_invoices[0]
          : row.trade_invoices;
        const lineType = row.line_type ?? null;
        if (JOB_WORK_ORDER_EXCLUDED_LINE_TYPES.has(String(lineType || ""))) {
          continue;
        }
        const status = String(inv?.status || "");
        const hours = row.work_order_hours ?? row.total_hours;
        out.push({
          trade_invoice_line_id: row.id,
          trade_invoice_id: row.trade_invoice_id,
          work_order_id: row.job_work_order_id ?? null,
          job_id: row.job_id,
          user_id: inv?.user_id ?? null,
          trade_name: inv?.users?.name ?? null,
          invoice_number: inv?.invoice_number ?? null,
          invoice_status: status,
          submitted_at: inv?.submitted_at ?? null,
          line_type: lineType,
          description: row.description ?? null,
          hours: hours === null || hours === undefined ? null : Number(hours),
          amount_ex: money(row.override_amount ?? row.line_total_ex),
          counted: JOB_WORK_ORDER_BILLED_INVOICE_STATUSES.has(status),
        });
      }
      if (!data || data.length < 1000) break;
      offset += 1000;
    }
  }
  return out;
}

async function readVariations(client: any, jobIds: string[]): Promise<any[]> {
  const out: any[] = [];
  for (let i = 0; i < jobIds.length; i += 25) {
    const { data, error } = await client.from("work_order_variations")
      .select(
        "id, job_id, work_order_id, trade_invoice_id, reported_by, description, amount_ex, status, created_at, users:reported_by(name)",
      )
      .in("job_id", jobIds.slice(i, i + 25))
      .order("created_at", { ascending: true });
    if (error) {
      fail(
        500,
        "variations_unreadable",
        "Work order variations could not be read",
      );
    }
    out.push(...(data || []));
  }
  return out;
}

function figuresFor(
  live: any,
  lines: WorkOrderLabourLine[],
  variations: any[],
) {
  return computeWorkOrderFigures({
    agreedEx: live?.agreed_labour_ex ?? null,
    approved: !!live,
    lines,
    variations: variations.map((v) => ({
      amount_ex: v.amount_ex === null || v.amount_ex === undefined
        ? null
        : Number(v.amount_ex),
      status: v.status,
      work_order_id: v.work_order_id,
    })),
  });
}

function invoicesFrom(lines: WorkOrderLabourLine[], variations: any[]) {
  const byInvoice = new Map<string, any>();
  for (const l of lines) {
    if (!l.work_order_id) continue;
    const cur = byInvoice.get(l.trade_invoice_id) || {
      trade_invoice_id: l.trade_invoice_id,
      invoice_number: l.invoice_number,
      status: l.invoice_status,
      counted: l.counted,
      trade_user_id: l.user_id,
      trade_name: l.trade_name,
      submitted_at: l.submitted_at,
      amount_ex: 0,
      hours: 0,
      has_variation: false,
    };
    cur.amount_ex = money(cur.amount_ex + l.amount_ex);
    cur.hours = Math.round((cur.hours + (l.hours || 0)) * 100) / 100;
    byInvoice.set(l.trade_invoice_id, cur);
  }
  for (const v of variations) {
    const cur = byInvoice.get(v.trade_invoice_id);
    if (cur && v.status === "reported") cur.has_variation = true;
  }
  return [...byInvoice.values()].sort((a, b) =>
    String(a.submitted_at || "").localeCompare(String(b.submitted_at || ""))
  );
}

function shapeVariation(v: any) {
  return {
    id: v.id,
    work_order_id: v.work_order_id,
    trade_invoice_id: v.trade_invoice_id,
    reported_by: v.reported_by,
    reported_by_name: v.users?.name ?? null,
    description: v.description,
    amount_ex: v.amount_ex === null || v.amount_ex === undefined
      ? null
      : money(v.amount_ex),
    status: v.status,
    created_at: v.created_at,
  };
}

// ── Staff: read one job's work order ─────────────────────────────────────────

export async function readJobWorkOrder(
  client: any,
  params: { jobId?: string | null; workOrderId?: string | null },
) {
  let jobId = params.jobId || null;
  if (!jobId && params.workOrderId) {
    const wo = await readWorkOrder(
      client,
      requireUuid(params.workOrderId, "work_order_id"),
    );
    if (wo.kind !== "job") {
      fail(
        422,
        "not_a_job_work_order",
        "That is a crew work order, not a job work order",
      );
    }
    jobId = wo.job_id;
  }
  const job = await readJob(client, requireUuid(jobId, "job_id"));
  const rows = await readJobWorkOrders(client, job.id);
  const live = liveOf(rows);
  const draft = draftOf(rows);
  const [lines, variations] = await Promise.all([
    readLabourLines(client, [job.id]),
    readVariations(client, [job.id]),
  ]);
  const linked = lines.filter((l) => l.work_order_id);
  const before = lines.filter((l) => !l.work_order_id && l.counted);
  return {
    schema: JOB_WORK_ORDER_SCHEMA,
    job: {
      id: job.id,
      job_number: job.job_number,
      client_name: job.client_name,
      type: job.type,
      status: job.status,
      site_address: job.site_address,
      site_suburb: job.site_suburb,
      work_order_id: job.work_order_id,
    },
    eligible: JOB_WORK_ORDER_JOB_TYPES.has(String(job.type || "")),
    work_order: live || draft || null,
    live_work_order: live,
    draft_work_order: draft,
    history: rows.filter((r) => r !== live && r !== draft),
    figures: figuresFor(live, linked, variations),
    invoices: invoicesFrom(linked, variations),
    labour_lines: linked,
    labour_before_approval: {
      amount_ex: money(before.reduce((s, l) => s + l.amount_ex, 0)),
      line_count: before.length,
      note:
        "Labour billed on this job before a work order was approved. Shown for reference, not counted.",
    },
    variations: variations.map(shapeVariation),
  };
}

// ── Staff: list job work orders ──────────────────────────────────────────────

export async function listJobWorkOrders(client: any, params: URLSearchParams) {
  const status = String(params.get("status") || "").trim();
  const type = String(params.get("type") || "").trim();
  const jobId = params.get("job_id") || params.get("jobId");
  if (
    status && !["draft", "approved", "cancelled", "superseded"].includes(status)
  ) {
    fail(
      400,
      "invalid_status",
      "status must be draft, approved, superseded or cancelled",
    );
  }
  if (type && !JOB_WORK_ORDER_JOB_TYPES.has(type)) {
    fail(400, "invalid_type", "type must be fencing or patio");
  }
  const rows: any[] = [];
  let offset = 0;
  while (true) {
    let q = client.from("work_orders")
      .select(`${WO_COLUMNS}, jobs:job_id!inner(${JOB_COLUMNS})`)
      .eq("kind", "job")
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(offset, offset + 999);
    if (jobId) q = q.eq("job_id", requireUuid(jobId, "job_id"));
    if (type) q = q.eq("jobs.type", type);
    if (status === "approved") {
      q = q.eq("status", "approved").is("superseded_at", null);
    } else if (status === "superseded") {
      q = q.eq("status", "approved").not("superseded_at", "is", null);
    } else if (status) q = q.eq("status", status);
    else q = q.neq("status", "cancelled").is("superseded_at", null);
    const { data, error } = await q;
    if (error) {
      fail(500, "work_orders_unreadable", "Job work orders could not be read");
    }
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
    offset += 1000;
  }
  const jobIds = [...new Set(rows.map((r) => String(r.job_id)))];
  const [lines, variations] = await Promise.all([
    readLabourLines(client, jobIds),
    readVariations(client, jobIds),
  ]);
  const work_orders = rows.map((r) => {
    const job = Array.isArray(r.jobs) ? r.jobs[0] : r.jobs;
    const isLive = r.status === "approved" && !r.superseded_at;
    const jobLines = lines.filter((l) =>
      l.job_id === r.job_id && l.work_order_id
    );
    const jobVariations = variations.filter((v) => v.job_id === r.job_id);
    const { jobs: _jobs, ...wo } = r;
    return {
      ...wo,
      job_number: job?.job_number ?? null,
      client_name: job?.client_name ?? null,
      job_type: job?.type ?? null,
      job_status: job?.status ?? null,
      site_suburb: job?.site_suburb ?? null,
      figures: isLive ? figuresFor(r, jobLines, jobVariations) : null,
    };
  });
  return {
    schema: "job-work-orders.v1",
    kind: "job",
    work_orders,
    total: work_orders.length,
  };
}

// ── Staff: open a draft (or a revision) ──────────────────────────────────────

export async function createJobWorkOrder(client: any, body: any) {
  const jobId = requireUuid(body?.job_id ?? body?.jobId, "job_id");
  const patch = validateJobWorkOrderDraftPatch(body);
  const job = await readJob(client, jobId);
  if (!JOB_WORK_ORDER_JOB_TYPES.has(String(job.type || ""))) {
    fail(
      422,
      "job_type_not_eligible",
      "Job work orders are for fencing and patio jobs",
    );
  }
  const rows = await readJobWorkOrders(client, jobId);
  const live = liveOf(rows);
  let draft = draftOf(rows);
  let created = false;
  if (!draft && live) {
    const revision = rows.filter((r) => r.kind === "job").length + 1;
    const base = String(
      live.wo_number || `WO-${job.job_number || jobId.slice(0, 8)}`,
    ).replace(/-R\d+$/, "");
    const { data, error } = await client.from("work_orders").insert({
      org_id: live.org_id || job.org_id,
      job_id: jobId,
      wo_number: `${base}-R${revision}`,
      kind: "job",
      status: "draft",
      scope_items: live.scope_items || [],
      special_instructions: live.special_instructions,
      scheduled_date: live.scheduled_date,
      site_address: live.site_address,
      agreed_labour_ex: live.agreed_labour_ex,
      supersedes_work_order_id: live.id,
      origin: "revision",
    }).select(WO_COLUMNS).single();
    if (error) {
      if (error.code === "23505") {
        fail(409, "draft_exists", "The job already has a draft work order");
      }
      fail(500, "draft_not_created", "The revision draft could not be created");
    }
    draft = data;
    created = true;
  } else if (!draft) {
    const { data: id, error } = await client.rpc(
      "ensure_job_work_order_draft",
      {
        p_job_id: jobId,
        p_origin: "manual",
      },
    );
    if (error || !id) {
      fail(
        500,
        "draft_not_created",
        "The draft work order could not be created",
      );
    }
    draft = await readWorkOrder(client, id);
    created = true;
  }
  if (Object.keys(patch).length > 0) {
    draft = await applyDraftPatch(client, draft, patch);
  }
  await logJobEvent(
    client,
    jobId,
    created ? "job_work_order_draft_opened" : "job_work_order_draft_updated",
    {
      work_order_id: draft.id,
      wo_number: draft.wo_number,
      revision_of: draft.supersedes_work_order_id || null,
    },
  );
  return { created, work_order: draft };
}

async function applyDraftPatch(
  client: any,
  wo: any,
  patch: Record<string, unknown>,
) {
  const { data, error } = await client.from("work_orders").update(patch)
    .eq("id", wo.id).eq("kind", "job").eq("status", "draft")
    .select(WO_COLUMNS).maybeSingle();
  if (error) {
    fail(500, "draft_not_updated", "The draft work order could not be saved");
  }
  if (!data) fail(409, "not_a_draft", "Only a draft work order can be edited");
  return data;
}

// ── Staff: edit a draft (approved ones are sealed) ───────────────────────────

export async function updateJobWorkOrderDraft(client: any, body: any) {
  const id = requireUuid(body?.id ?? body?.work_order_id, "id");
  const wo = await readWorkOrder(client, id);
  if (wo.kind !== "job") {
    fail(
      422,
      "not_a_job_work_order",
      "That is a crew work order, not a job work order",
    );
  }
  if (wo.status === "approved") {
    fail(
      409,
      "work_order_sealed",
      "This work order is approved and sealed. Open a revision to change it.",
    );
  }
  if (wo.status !== "draft") {
    fail(409, "not_a_draft", `This work order is ${wo.status}`);
  }
  if (body?.status !== undefined && body.status !== "draft") {
    if (body.status !== "cancelled") {
      fail(
        400,
        "invalid_status",
        "A draft can only be cancelled here. Use approve_work_order to approve it.",
      );
    }
    const { data, error } = await client.from("work_orders").update({
      status: "cancelled",
    })
      .eq("id", id).eq("status", "draft").select(WO_COLUMNS).maybeSingle();
    if (error || !data) {
      fail(409, "not_a_draft", "The draft could not be cancelled");
    }
    const live = liveOf(await readJobWorkOrders(client, wo.job_id));
    const { error: jobErr } = await client.from("jobs").update({
      work_order_id: live?.id ?? null,
    })
      .eq("id", wo.job_id).eq("work_order_id", id);
    if (jobErr) {
      console.error(
        "[job-work-orders] job reference not cleared:",
        jobErr.message,
      );
    }
    await logJobEvent(client, wo.job_id, "job_work_order_draft_cancelled", {
      work_order_id: id,
      wo_number: wo.wo_number,
    });
    return { work_order: data };
  }
  const patch = validateJobWorkOrderDraftPatch(body);
  if (Object.keys(patch).length === 0) {
    fail(400, "nothing_to_update", "No editable field was given");
  }
  return { work_order: await applyDraftPatch(client, wo, patch) };
}

// ── Staff: approve (approver only) ───────────────────────────────────────────

export async function readWorkOrderApprovers(client: any): Promise<string[]> {
  const { data, error } = await client.from("work_order_settings").select(
    "approver_user_ids",
  ).eq("id", 1).maybeSingle();
  if (error) {
    fail(
      503,
      "approvers_unreadable",
      "The work order approver list could not be read",
    );
  }
  return (data?.approver_user_ids || []).map((v: unknown) =>
    String(v).toLowerCase()
  );
}

const APPROVE_ERRORS: Record<string, [number, string]> = {
  "42501": [403, "approver_required"],
  "23514": [422, "work_order_not_ready"],
  "23505": [409, "live_work_order_exists"],
  "40001": [409, "revision_stale"],
  "P0002": [404, "work_order_not_found"],
};

export async function approveJobWorkOrder(
  client: any,
  body: any,
  approver: WorkOrderApprover | null,
) {
  const id = requireUuid(body?.id ?? body?.work_order_id, "work_order_id");
  if (!approver) {
    fail(
      403,
      "approver_identity_missing",
      "Approving needs Shaun's own session, or his terminal naming him (x-sw-actor user:<id>).",
    );
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
    fail(403, "approver_required", "Only Shaun approves job work orders");
  }
  const wo = await readWorkOrder(client, id);
  if (wo.kind !== "job") {
    fail(422, "not_a_job_work_order", "Only a job work order is approved");
  }
  if (wo.status !== "draft") {
    fail(409, "not_a_draft", `This work order is ${wo.status}`);
  }
  const expected = body?.expected_updated_at;
  if (
    expected !== undefined && expected !== null &&
    String(expected) !== String(wo.updated_at)
  ) {
    fail(
      409,
      "stale_review",
      "The draft changed after it was read. Read it again before approving.",
    );
  }
  const { data, error } = await client.rpc("approve_job_work_order", {
    p_work_order_id: id,
    p_approver: approver.userId,
    p_via: approver.via,
  });
  if (error) {
    const mapped = APPROVE_ERRORS[String(error.code || "")];
    if (mapped) {
      fail(mapped[0], mapped[1], String(error.message || "Approval refused"));
    }
    fail(500, "approval_failed", "The work order could not be approved");
  }
  await logJobEvent(client, wo.job_id, "job_work_order_approved", {
    work_order_id: id,
    wo_number: wo.wo_number,
    approved_by: approver.userId,
    via: approver.via,
    agreed_labour_ex: data?.agreed_labour_ex ?? wo.agreed_labour_ex,
    sealed_content_hash: data?.sealed_content_hash ?? null,
    superseded_work_order_id: wo.supersedes_work_order_id || null,
  }, approver.userId);
  return { work_order: data };
}

// ── Staff: backfill (switched off) ───────────────────────────────────────────

export async function backfillJobWorkOrders(client: any, body: any) {
  const apply = body?.apply === true;
  const { data, error } = await client.rpc("backfill_job_work_order_drafts", {
    p_apply: apply,
  });
  if (error) {
    if (String(error.code) === "42501") {
      fail(
        403,
        "backfill_switched_off",
        "The job work order backfill is switched off (feature flag job_work_order_backfill_v1)",
      );
    }
    fail(500, "backfill_failed", "The backfill could not run");
  }
  return data;
}

// ── Trade: read the approved work order without prices ───────────────────────

export async function tradeJobWorkOrderRead(
  client: any,
  jobId: string,
  viewerId: string,
  redact: TradeRedaction,
) {
  const job = await readJob(client, jobId);
  const live = liveOf(await readJobWorkOrders(client, jobId));
  const { data: mine, error } = await client.from("work_order_variations")
    .select("id, description, status, created_at, trade_invoice_id")
    .eq("job_id", jobId).eq("reported_by", viewerId).order("created_at", {
      ascending: true,
    });
  if (error) {
    fail(500, "variations_unreadable", "Your variations could not be read");
  }
  return {
    schema: TRADE_JOB_WORK_ORDER_SCHEMA,
    job_id: jobId,
    work_order: live ? projectTradeJobWorkOrder(live, job, redact) : null,
    reason: live ? null : "no_approved_work_order",
    can_report_variation: JOB_WORK_ORDER_JOB_TYPES.has(String(job.type || "")),
    my_variations: (mine || []).map((v: any) => ({
      id: v.id,
      trade_invoice_id: v.trade_invoice_id,
      description: v.description,
      status: v.status,
      created_at: v.created_at,
    })),
  };
}

// ── Trade: report a variation on the trade's own invoice ─────────────────────

export type VariationEmailSender = (
  email: VariationEmail & { jobId: string },
) => Promise<
  { ok: true } | { ok: false; error: string }
>;

export async function readFlag(client: any, flag: string): Promise<boolean> {
  try {
    const { data, error } = await client.from("feature_flags").select("enabled")
      .eq("flag_name", flag).limit(1);
    if (error) return false;
    return data?.[0]?.enabled === true;
  } catch {
    return false;
  }
}

export async function reportWorkOrderVariation(
  client: any,
  body: any,
  trade: { id: string; orgId: string; name?: string | null },
  deps: { sendEmail: VariationEmailSender },
) {
  const invoiceId = requireUuid(body?.trade_invoice_id, "trade_invoice_id");
  const jobId = requireUuid(body?.job_id, "job_id");
  const description = typeof body?.description === "string"
    ? body.description.trim()
    : "";
  if (!description || description.length > MAX_VARIATION_TEXT) {
    fail(
      400,
      "invalid_description",
      `Describe the variation in 1 to ${MAX_VARIATION_TEXT} characters`,
    );
  }
  let amountEx: number | null = null;
  if (
    body?.amount_ex !== undefined && body?.amount_ex !== null &&
    body?.amount_ex !== ""
  ) {
    const n = Number(body.amount_ex);
    if (!Number.isFinite(n) || n < 0 || n > 1_000_000) {
      fail(400, "invalid_amount_ex", "amount_ex must be zero or more");
    }
    amountEx = money(n);
  }

  const { data: invoice, error: invErr } = await client.from("trade_invoices")
    .select("id, org_id, user_id, status, invoice_number").eq("id", invoiceId)
    .maybeSingle();
  if (invErr) fail(500, "invoice_unreadable", "The invoice could not be read");
  if (
    !invoice || String(invoice.user_id) !== trade.id ||
    String(invoice.org_id) !== trade.orgId
  ) {
    fail(404, "invoice_not_found", "Invoice not found");
  }
  if (invoice.status === "ops-reject") {
    fail(409, "invoice_rejected", "This invoice was rejected");
  }

  const { data: lineRows, error: lineErr } = await client.from(
    "trade_invoice_lines",
  )
    .select("id").eq("trade_invoice_id", invoiceId).eq("job_id", jobId).limit(
      1,
    );
  if (lineErr) fail(500, "invoice_unreadable", "The invoice could not be read");
  if (!lineRows?.length) {
    fail(422, "job_not_on_invoice", "This invoice has no line for that job");
  }

  const job = await readJob(client, jobId);
  if (!JOB_WORK_ORDER_JOB_TYPES.has(String(job.type || ""))) {
    fail(
      422,
      "job_type_not_eligible",
      "Work order variations are for fencing and patio jobs",
    );
  }
  const rows = await readJobWorkOrders(client, jobId);
  const live = liveOf(rows);

  const { data: inserted, error: insErr } = await client.from(
    "work_order_variations",
  ).insert({
    org_id: trade.orgId,
    job_id: jobId,
    work_order_id: live?.id ?? null,
    trade_invoice_id: invoiceId,
    reported_by: trade.id,
    description,
    amount_ex: amountEx,
  }).select(
    "id, job_id, work_order_id, trade_invoice_id, description, amount_ex, status, created_at",
  ).single();
  if (insErr) {
    if (insErr.code === "23505") {
      const { data: existing } = await client.from("work_order_variations")
        .select(
          "id, job_id, work_order_id, trade_invoice_id, description, amount_ex, status, created_at",
        )
        .eq("trade_invoice_id", invoiceId).eq("job_id", jobId).maybeSingle();
      if (
        existing && existing.description === description &&
        (existing.amount_ex === null ? null : money(existing.amount_ex)) ===
          amountEx
      ) {
        return { variation: existing, duplicate: true, emails: [] };
      }
      fail(
        409,
        "variation_exists",
        "A different variation is already recorded for this job on this invoice",
      );
    }
    fail(500, "variation_not_saved", "The variation could not be saved");
  }

  let figures: WorkOrderFigures | null = null;
  if (live) {
    try {
      const [lines, variations] = await Promise.all([
        readLabourLines(client, [jobId]),
        readVariations(client, [jobId]),
      ]);
      figures = figuresFor(
        live,
        lines.filter((l) => l.work_order_id),
        variations,
      );
    } catch (_e) {
      figures = null;
    }
  }
  const emails = buildVariationEmails({
    jobNumber: job.job_number,
    siteSuburb: job.site_suburb,
    woNumber: live?.wo_number ?? null,
    tradeName: trade.name ?? null,
    invoiceNumber: invoice.invoice_number ?? null,
    description,
    amountEx,
    figures,
  });
  const emailResults = await recordAndMaybeSendVariationEmails(
    client,
    inserted.id,
    jobId,
    emails,
    deps.sendEmail,
  );
  await logJobEvent(client, jobId, "work_order_variation_reported", {
    variation_id: inserted.id,
    work_order_id: live?.id ?? null,
    trade_invoice_id: invoiceId,
    amount_ex: amountEx,
  }, trade.id);
  return { variation: inserted, duplicate: false, emails: emailResults };
}

/**
 * One ledger row per recipient (finance, admin). Sends nothing unless the
 * feature flag is on at the moment the variation is reported. A row is claimed
 * recorded -> sending before the send, so a retry can never send it twice.
 */
export async function recordAndMaybeSendVariationEmails(
  client: any,
  variationId: string,
  jobId: string,
  emails: VariationEmail[],
  sendEmail: VariationEmailSender,
) {
  const results: Array<{ recipient_role: string; status: string }> = [];
  const { data: rows, error } = await client.from("work_order_variation_emails")
    .upsert(
      emails.map((e) => ({ variation_id: variationId, ...e })),
      { onConflict: "variation_id,recipient_role", ignoreDuplicates: true },
    ).select("id, recipient_role, status");
  if (error) {
    console.error(
      "[job-work-orders] variation emails not recorded:",
      error.message,
    );
    return emails.map((e) => ({
      recipient_role: e.recipient_role,
      status: "not_recorded",
    }));
  }
  const sendOn = await readFlag(client, WORK_ORDER_VARIATION_EMAILS_FLAG);
  for (const email of emails) {
    const row = (rows || []).find((r: any) =>
      r.recipient_role === email.recipient_role
    );
    if (!row) {
      results.push({
        recipient_role: email.recipient_role,
        status: "already_recorded",
      });
      continue;
    }
    if (!sendOn) {
      results.push({
        recipient_role: email.recipient_role,
        status: "recorded",
      });
      continue;
    }
    const { data: claimed } = await client.from("work_order_variation_emails")
      .update({ status: "sending" }).eq("id", row.id).eq("status", "recorded")
      .select("id").maybeSingle();
    if (!claimed) {
      results.push({
        recipient_role: email.recipient_role,
        status: "claimed_elsewhere",
      });
      continue;
    }
    let outcome: { ok: true } | { ok: false; error: string };
    try {
      outcome = await sendEmail({ ...email, jobId });
    } catch (e) {
      outcome = { ok: false, error: (e as Error)?.message || "send threw" };
    }
    const patch = outcome.ok
      ? { status: "sent", sent_at: new Date().toISOString() }
      : { status: "failed", send_error: outcome.error.slice(0, 500) };
    const { error: updErr } = await client.from("work_order_variation_emails")
      .update(patch).eq("id", row.id);
    if (updErr) {
      console.error(
        "[job-work-orders] variation email outcome not saved:",
        updErr.message,
      );
    }
    results.push({
      recipient_role: email.recipient_role,
      status: patch.status,
    });
  }
  return results;
}

/** Production sender: admin@ mailbox through send-outlook-email (Graph). */
export function sendOutlookVariationEmail(
  supabaseUrl: string,
  serviceKey: string,
  fetchImpl: typeof fetch = fetch,
): VariationEmailSender {
  return async (email) => {
    const resp = await fetchImpl(
      `${supabaseUrl}/functions/v1/send-outlook-email`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceKey}`,
          apikey: serviceKey,
        },
        body: JSON.stringify({
          mailbox: WORK_ORDER_VARIATION_SENDER_MAILBOX,
          to: email.recipient,
          subject: email.subject,
          htmlBody: email.body_html,
          job_id: email.jobId,
        }),
      },
    );
    if (resp.ok) return { ok: true };
    const text = await resp.text().catch(() => "");
    return {
      ok: false,
      error: `send-outlook-email ${resp.status}: ${text}`.slice(0, 500),
    };
  };
}

async function logJobEvent(
  client: any,
  jobId: string,
  eventType: string,
  detail: Record<string, unknown>,
  userId?: string | null,
) {
  try {
    const { error } = await client.from("job_events").insert({
      job_id: jobId,
      event_type: eventType,
      user_id: userId ?? null,
      detail_json: detail,
    });
    if (error) {
      console.error(
        `[job-work-orders] ${eventType} event not logged:`,
        error.message,
      );
    }
  } catch (e) {
    console.error(
      `[job-work-orders] ${eventType} event not logged:`,
      (e as Error)?.message,
    );
  }
}
