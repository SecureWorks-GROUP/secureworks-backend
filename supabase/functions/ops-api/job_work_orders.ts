// deno-lint-ignore-file no-explicit-any
// Job work orders: one live work order per fencing and patio job (captain,
// 6 Oct 2026). Schema, seal, triggers and backfill:
// 20261012130000_job_work_orders.sql. Screen contract:
// docs/job-work-orders-v1.md.
//
// A job work order is a work_orders row with kind = 'job'. It is a draft
// (editable, counts for nothing) until an approver named in
// work_order_settings (seeded with Shaun's users.id) approves it. Approving
// seals it like an invoice: the database refuses any later edit, and later
// change is recorded as a variation (the trade's overrun, or the office's
// customer variation as an addendum).
//
//   Staff (ops key or staff session):
//     job_work_order          GET   one job's work order, live figures, labour
//                                   lines, invoices and variations
//     list_work_orders        GET   kind=job lists job work orders with figures
//     create_work_order       POST  kind=job opens (or edits) the job's draft
//     update_work_order       POST  edits a job DRAFT (approved ones are sealed)
//     approve_work_order      POST  approver only (see resolveWorkOrderApprover);
//                                   seals only the draft as it was read
//                                   (expected_updated_at is required)
//     backfill_job_work_orders POST ops key only; dry run unless apply:true AND
//                                   feature flag job_work_order_backfill_v1 is on
//     auto_issue_job_work_orders POST ops key only (the pg_cron sweep); fills
//                                   and issues job work orders with no human
//                                   approval while job_work_order_auto_issue_v1
//                                   is on, nothing otherwise
//     resend_work_order_variation_emails POST re-sends variation emails left
//                                   failed, or stuck in sending past the
//                                   staleness bound; nothing while the email
//                                   flag is off
//     correct_work_order_variation POST corrects a variation's amount and
//                                   description, keeping what the trade first
//                                   reported and who corrected it; never a
//                                   trade door
//   Trade (signed-in Trade App user with access to the job):
//     my_job_work_order       GET   the approved work order's scope and agreed
//                                   details, every price and allowance left out
//     report_work_order_variation POST a variation on the trade's own invoice;
//                                   records the finance and admin emails, sent
//                                   only while work_order_variation_emails_v1 is on
//
// While JOB_WORK_ORDER_AUTO_ISSUE_FLAG is on, a draft the quote fill wrote
// that nobody has edited since is issued by the system (approved_via 'auto',
// no approver; 20261016120000_job_work_order_auto_issue.sql): by the sweep,
// on an ops status change, and by the backfill. A draft edited by hand waits
// for the approver; customer variations always do.
//
// A draft is filled from the accepted quote (job_work_order_quote_fill.ts,
// docs/quote-work-order-lines-v1.md) while nobody has written into it: when
// staff open it, when staff read it, and by the backfill. A read fills only
// when its caller asks (fillFromQuote: staff or the ops server key, never the
// routine key). An approved work order is never filled.
//
// Customer variations (work_order_customer_variations.ts, the office's record
// of a variation the customer agreed to) join the approved work order as
// numbered addenda once approved: every read here returns them (`addenda`),
// the figures measure billed against the agreed labour plus their trade
// allocation (`agreed_total_ex`), and the trade read shows their lines with
// hours and marked as variations, never their allocation or price.
//
// Invoice lines billed on the job are stamped by the database at invoice
// submit, and at approval for lines invoiced earlier
// (trade_invoice_lines.job_work_order_id); this module only reads them. Only
// labour-lane lines count against the agreed labour; the rest are listed.

import {
  fillJobWorkOrderDraftFromQuote,
  JOB_WORK_ORDER_OPEN_STATUSES,
  jobWorkOrderDraftIsUntouched,
  QuoteFillError,
  type QuoteFillOutcome,
} from "./job_work_order_quote_fill.ts";

export const JOB_WORK_ORDER_SCHEMA = "job-work-order.v1";
export const TRADE_JOB_WORK_ORDER_SCHEMA = "trade-job-work-order.v1";

export const JOB_WORK_ORDER_JOB_TYPES: ReadonlySet<string> = new Set([
  "fencing",
  "patio",
]);

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

/**
 * The one cost lane that counts against the agreed labour. The lane of a line
 * is v_trade_charge_resolved.cost_lane (newest definition: 20261015093000),
 * the repo's single definition; this module reads it and never restates it.
 */
export const WORK_ORDER_LABOUR_COST_LANE = "labour";

/**
 * Whether a line is labour against the agreed labour figure: the one place
 * that decides it.
 *
 * REDUNDANT: the trade app's "Work Order" pay line (line_type 'work order',
 * or 'work_order') is labour, and v_trade_charge_resolved puts both types in
 * its labour lane since migration 20261015093000 (owner call JP-04). The
 * line-type test below predates that and agrees with the view; remove it
 * separately.
 */
export function workOrderLineIsLabour(
  line: { cost_lane: string; line_type: string | null },
): boolean {
  return line.cost_lane === WORK_ORDER_LABOUR_COST_LANE ||
    line.line_type === "work order" || line.line_type === "work_order";
}

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
/** Off: approve_work_order refuses an approver named only by x-sw-actor. */
export const WORK_ORDER_TERMINAL_APPROVAL_FLAG =
  "work_order_terminal_approval_v1";
/** A variation email left in `sending` this long is taken to be abandoned. */
export const WORK_ORDER_VARIATION_EMAIL_STALE_SENDING_MS = 10 * 60 * 1000;

/** Rule near_agreed fires at this share of the agreed labour. */
export const WORK_ORDER_NEAR_AGREED_RATIO = 0.9;

/** Issues a job work order to the trades as soon as the quote fill writes it,
 *  with no human approval (approved_via 'auto'). Seeded off. */
export const JOB_WORK_ORDER_AUTO_ISSUE_FLAG = "job_work_order_auto_issue_v1";

/** Open, approved job statuses. Mirrors the database's
 *  job_work_order_open_statuses() (20261012130000): the jobs a draft is opened
 *  for, and the only jobs whose work order is issued automatically. Declared
 *  in job_work_order_quote_fill.ts, which also reads it (a job moved past
 *  quoted), so the two modules import no cycle. */
export { JOB_WORK_ORDER_OPEN_STATUSES };

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
 *   terminal  a server-secret call (SecureSuite) whose x-sw-actor header
 *             names the user as `user:<users.id>`. The header is self-declared
 *             by a caller that holds a server secret, so approveJobWorkOrder
 *             refuses it until WORK_ORDER_TERMINAL_APPROVAL_FLAG is on.
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

export type WorkOrderLine = {
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
  /** v_trade_charge_resolved.cost_lane: labour, materials, commission, other, unclassified. */
  cost_lane: string;
  /** In the billed totals: a labour line (workOrderLineIsLabour) on an invoice that is billed. */
  counted: boolean;
};

export type WorkOrderRule = {
  key:
    | "over_agreed"
    | "near_agreed"
    | "has_variations"
    | "has_customer_variations"
    | "no_approved_work_order";
  level: "flag" | "warn" | "info";
  message: string;
};

export type WorkOrderFigures = {
  agreed_ex: number | null;
  /** Trade allocation of the approved customer variations (addenda). */
  customer_variations_ex: number;
  /** What the approved customer variations charge the customer, ex GST. */
  customer_variations_price_ex: number;
  customer_variation_count: number;
  /** agreed_ex plus customer_variations_ex: what billed is measured against. */
  agreed_total_ex: number | null;
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
 *   billed_to_date_ex  every counted line stamped against the job's approved
 *                      work order: labour lane only, on a billed invoice
 *                      (variation work included, since the trade bills a
 *                      variation on the same invoice). Materials, travel,
 *                      equipment and other lines are never in it.
 *   variations_ex      the part of billed the trades marked as variations;
 *                      a variation counts only while its invoice is billed.
 *   customer_variations_ex  the trade allocation of the approved customer
 *                      variations (the work order's addenda).
 *   agreed_total_ex    agreed + customer_variations_ex: billed is measured
 *                      against it.
 *   remaining_ex       agreed_total - billed_to_date.
 * Rules (named, in the PR and docs/job-work-orders-v1.md):
 *   over_agreed   flag  billed > agreed total (agreed + approved customer variations)
 *   near_agreed   warn  billed >= 90% of the agreed total and not over
 *   has_variations info at least one trade variation reported on the work order
 *   has_customer_variations info at least one approved customer variation
 *   no_approved_work_order info nothing counts until a work order is approved
 */
export function computeWorkOrderFigures(input: {
  agreedEx: number | null;
  approved: boolean;
  lines: Array<
    Pick<WorkOrderLine, "amount_ex" | "counted" | "work_order_id">
  >;
  variations: Array<
    {
      amount_ex: number | null;
      work_order_id: string | null;
      counted: boolean;
    }
  >;
  /** Customer variations on the job; only approved ones count. */
  customerVariations?: Array<
    {
      status: string;
      work_order_id: string | null;
      trade_allocation_ex: number | null;
      customer_price_ex: number | null;
    }
  >;
}): WorkOrderFigures {
  const counted = input.lines.filter((l) => l.counted && l.work_order_id);
  const billed = money(counted.reduce((s, l) => s + money(l.amount_ex), 0));
  const liveVariations = input.variations.filter((v) =>
    v.work_order_id && v.counted
  );
  const variationsEx = money(
    liveVariations.reduce((s, v) => s + money(v.amount_ex ?? 0), 0),
  );
  const addenda = input.approved
    ? (input.customerVariations || []).filter((v) =>
      v.status === "approved" && v.work_order_id
    )
    : [];
  const customerEx = money(
    addenda.reduce((s, v) => s + money(v.trade_allocation_ex ?? 0), 0),
  );
  const customerPriceEx = money(
    addenda.reduce((s, v) => s + money(v.customer_price_ex ?? 0), 0),
  );
  const agreed = input.approved && input.agreedEx !== null &&
      input.agreedEx !== undefined
    ? money(input.agreedEx)
    : null;
  const total = agreed === null ? null : money(agreed + customerEx);
  const against = addenda.length > 0
    ? `the agreed $${(total ?? 0).toFixed(2)} (including $${
      customerEx.toFixed(2)
    } of approved variations)`
    : `the agreed $${(total ?? 0).toFixed(2)}`;
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
  if (total !== null) {
    usedRatio = total > 0
      ? Math.round((billed / total) * 10000) / 10000
      : (billed > 0 ? null : 0);
    over = billed > total;
    if (over) {
      rules.push({
        key: "over_agreed",
        level: "flag",
        message: `Billed $${billed.toFixed(2)} is over ${against}.`,
      });
    } else if (total > 0 && billed >= total * WORK_ORDER_NEAR_AGREED_RATIO) {
      rules.push({
        key: "near_agreed",
        level: "warn",
        message: `Billed $${billed.toFixed(2)} is ${
          Math.round((billed / total) * 100)
        }% of ${against}.`,
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
  if (addenda.length > 0) {
    rules.push({
      key: "has_customer_variations",
      level: "info",
      message: `${addenda.length} approved customer variation${
        addenda.length === 1 ? "" : "s"
      } added $${customerEx.toFixed(2)} to the agreed labour.`,
    });
  }
  return {
    agreed_ex: agreed,
    customer_variations_ex: customerEx,
    customer_variations_price_ex: customerPriceEx,
    customer_variation_count: addenda.length,
    agreed_total_ex: total,
    billed_to_date_ex: billed,
    variations_ex: variationsEx,
    variation_count: liveVariations.length,
    billed_within_agreed_scope_ex: money(billed - variationsEx),
    remaining_ex: total === null ? null : money(total - billed),
    used_ratio: usedRatio,
    over_agreed: over,
    rules,
  };
}

// ── Pure: the office's "needs checking" note ────────────────────────────────

export type JobWorkOrderHeldReason =
  | "hand_edited"
  | "not_filled"
  | "agreed_labour_missing"
  | "filled_before_auto_issue"
  | "auto_issue_switched_off"
  | "awaiting_auto_issue";

export type JobWorkOrderNeedsChecking = {
  /** True when a line needs checking or the draft waits on the office. */
  needs_checking: boolean;
  /** The work order's lines the quote fill flagged for review. */
  lines: Array<{
    line_key: string | null;
    description: string | null;
    flags: string[];
  }>;
  /** Approved by the system (approved_via auto), not by a person. */
  issued_automatically: boolean;
  /** Why a draft has not gone to the trades; null once approved. */
  held: { reason: JobWorkOrderHeldReason; message: string } | null;
  message: string | null;
};

const HELD_MESSAGES: Record<JobWorkOrderHeldReason, string> = {
  hand_edited:
    "Edited by hand, so it is not issued automatically. Approve it to send it to the trades.",
  not_filled:
    "Not filled from an accepted quote. Fill it in and approve it to send it to the trades.",
  agreed_labour_missing:
    "The quote has no labour figure. Set the agreed labour and approve it to send it to the trades.",
  filled_before_auto_issue:
    "Filled before automatic issue, and it cannot be shown untouched since. Approve it to send it to the trades.",
  auto_issue_switched_off:
    "Goes to the trades automatically once automatic issue is switched on.",
  awaiting_auto_issue: "Goes to the trades automatically within a few minutes.",
};

/** Held reasons the office has to act on; the other two clear by themselves. */
const HELD_FOR_THE_OFFICE: ReadonlySet<JobWorkOrderHeldReason> = new Set([
  "hand_edited",
  "not_filled",
  "agreed_labour_missing",
  "filled_before_auto_issue",
]);

/**
 * The office-only note on a job work order: the lines the quote fill flagged
 * (they never stop the work order going out) and, for a draft, why it has
 * not gone to the trades yet. Read from the work order itself, stored
 * nowhere. Trades never see it: the trade read is an allowlist without flags.
 */
export function jobWorkOrderNeedsChecking(
  wo: any,
  autoIssueOn: boolean | null,
): JobWorkOrderNeedsChecking | null {
  if (!wo || wo.kind !== "job") return null;
  const items = Array.isArray(wo.scope_items) ? wo.scope_items : [];
  const lines = items
    .filter((i: any) => i && typeof i === "object" && i.needs_review === true)
    .map((i: any) => ({
      line_key: typeof i.line_key === "string" ? i.line_key : null,
      description: typeof i.description === "string" ? i.description : null,
      flags: Array.isArray(i.flags) ? i.flags.map(String) : [],
    }));
  let held: JobWorkOrderNeedsChecking["held"] = null;
  if (wo.status === "draft") {
    const hasScope = items.length > 0 ||
      writtenText(wo.special_instructions);
    const reason: JobWorkOrderHeldReason = wo.hand_edited_at
      ? "hand_edited"
      : !hasScope
      ? "not_filled"
      : wo.agreed_labour_ex === null || wo.agreed_labour_ex === undefined
      ? "agreed_labour_missing"
      : !wo.quote_filled_at
      ? "filled_before_auto_issue"
      : autoIssueOn === true
      ? "awaiting_auto_issue"
      : "auto_issue_switched_off";
    held = { reason, message: HELD_MESSAGES[reason] };
  }
  const messages: string[] = [];
  if (lines.length > 0) {
    messages.push(
      `${lines.length} line${lines.length === 1 ? "" : "s"} need${
        lines.length === 1 ? "s" : ""
      } checking against the quote.${
        wo.status === "approved"
          ? " The work order went to the trades as it is; a change is made as a variation."
          : ""
      }`,
    );
  }
  if (held) messages.push(held.message);
  return {
    needs_checking: lines.length > 0 ||
      (held !== null && HELD_FOR_THE_OFFICE.has(held.reason)),
    lines,
    issued_automatically: wo.status === "approved" &&
      wo.approved_via === "auto",
    held,
    message: messages.length > 0 ? messages.join(" ") : null,
  };
}

// ── Pure: validation of draft edits ──────────────────────────────────────────

export function validateJobWorkOrderDraftPatch(
  body: any,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (body?.scope_items !== undefined) {
    const items = body.scope_items;
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
  const instructions = body?.special_instructions;
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
  const agreed = body?.agreed_labour_ex;
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
  const scheduled = body?.scheduled_date;
  if (scheduled !== undefined) {
    if (scheduled !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(scheduled))) {
      fail(400, "invalid_scheduled_date", "scheduled_date must be YYYY-MM-DD");
    }
    out.scheduled_date = scheduled;
  }
  const address = body?.site_address;
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
  /** A scope item key the filter can show as prose (never a price key). */
  scopeTextKey: (key: string) => boolean;
};

// Heights and lengths are the work order, so they are set aside before the
// shared trade money filter (which drops decimals and 3+ digit numbers as
// possible amounts) and put back after it. Only three shapes are a
// measurement: a number then a length unit (2.1 m, 1800mm, 24.5 m2), a
// dimension run ending in a unit (6.5 x 4.2 m), and a number then a dimension
// word (1800 high). A number after a currency sign or before a GST mark is
// never one, and every other number stays with the money filter.
const WO_MEASURE_NUMBER = "\\d+(?:\\.\\d+)?";
const WO_MEASURE_UNIT =
  "(?:mm|cm|m2|m\u00B2|sqm|lm|metres?|meters?|m)(?![A-Za-z0-9])";
const WO_MEASURE_HEAD = "(?<![\\w.,])(?<![$\\p{Sc}]\\s*)";
const WO_MEASURE_TAIL =
  "(?!\\s*\\(?\\s*(?:(?:ex\\w*|inc\\w*|plus)\\b\\.?|\\+)?\\s*(?:of\\s+)?(?:gst|tax)\\b)";
const WO_MEASURE_RE = new RegExp(
  `${WO_MEASURE_HEAD}(?:` +
    `(?:${WO_MEASURE_NUMBER}(?:\\s?${WO_MEASURE_UNIT})?\\s*[x\u00D7]\\s*)+${WO_MEASURE_NUMBER}\\s?${WO_MEASURE_UNIT}` +
    `|${WO_MEASURE_NUMBER}\\s?${WO_MEASURE_UNIT}` +
    `|${WO_MEASURE_NUMBER}\\s+(?:high|long|wide|deep|height|length|width)\\b` +
    `)${WO_MEASURE_TAIL}`,
  "giu",
);
// One private-use character stands in for each measurement: the money filter
// has no rule that reads or removes one.
const WO_MEASURE_MARK_FIRST = 0xE000;
const WO_MEASURE_MARK_LAST = 0xF8FF;
const WO_MEASURE_MARK_RE = /[\uE000-\uF8FF]/g;

function holdWorkOrderMeasurements(value: string, kept: string[]): string {
  return value.replace(WO_MEASURE_MARK_RE, "").replace(
    WO_MEASURE_RE,
    (match) => {
      const mark = WO_MEASURE_MARK_FIRST + kept.length;
      if (mark > WO_MEASURE_MARK_LAST) return match;
      kept.push(match);
      return String.fromCharCode(mark);
    },
  );
}

function restoreWorkOrderMeasurements(value: string, kept: string[]): string {
  return value.replace(
    WO_MEASURE_MARK_RE,
    (mark) => kept[mark.charCodeAt(0) - WO_MEASURE_MARK_FIRST] ?? "",
  );
}

/**
 * What the trade reads in place of a scope line or special instruction the
 * shared money filter withheld whole: the line exists, none of it is shown.
 */
export const TRADE_WORK_ORDER_LINE_WITHHELD =
  "Line withheld. Ask the office for this detail.";

function mapStringLeaves(item: unknown, map: (value: string) => string) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  return Object.fromEntries(
    Object.entries(item).map((
      [key, value],
    ) => [key, typeof value === "string" ? map(value) : value]),
  );
}

/**
 * What a trade sees: scope and agreed details only. Built from an explicit
 * allowlist, so agreed_labour_ex, figures, billed amounts and any price on a
 * scope item can never reach it.
 */
export function projectTradeJobWorkOrder(
  wo: any,
  job: any,
  redact: TradeRedaction,
  addenda: CustomerVariationAddendum[] = [],
): Record<string, unknown> {
  const kept: string[] = [];
  const hold = (value: string) => holdWorkOrderMeasurements(value, kept);
  const restore = (value: string) => restoreWorkOrderMeasurements(value, kept);
  const shownText = (value: unknown, key: string): string | null => {
    if (typeof value !== "string") return null;
    const shown = restore(redact.text(hold(value), key));
    return writtenText(shown)
      ? shown
      : writtenText(value)
      ? TRADE_WORK_ORDER_LINE_WITHHELD
      : null;
  };
  // One item at a time, so a withheld line is matched to what was written.
  const tradeItems = (items: unknown) =>
    (Array.isArray(items) ? items : []).flatMap((item: unknown) => {
      const [seen] = redact.scopeItems([mapStringLeaves(item, hold)]);
      if (!seen || typeof seen !== "object" || Array.isArray(seen)) return [];
      const shown = mapStringLeaves(seen, restore) as Record<string, unknown>;
      for (const [key, value] of Object.entries(item as object)) {
        if (
          writtenText(value) && redact.scopeTextKey(key) &&
          !writtenText(shown[key])
        ) {
          shown[key] = TRADE_WORK_ORDER_LINE_WITHHELD;
        }
      }
      return [shown];
    });
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
    scope_items: tradeItems(wo.scope_items),
    special_instructions: shownText(
      wo?.special_instructions,
      "special_instructions",
    ),
    // Approved customer variations, each a marked addendum: its number, the
    // label built here from the number and the approval day, what the office
    // wrote, and its task lines with their hours. Built field by field, so the
    // trade allocation and the customer price can never reach it.
    addenda: addenda.map((a) => ({
      variation_number: a.variation_number,
      label: a.label,
      approved_at: a.approved_at,
      description: shownText(a.description, "description"),
      scope_items: tradeItems(a.lines),
    })),
  };
}

function writtenText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

// ── Pure: customer variations as addenda ─────────────────────────────────────

/** One task of a customer variation, as stored. */
export type CustomerVariationTask = {
  description: string;
  hours: number;
  qty?: number | null;
  unit?: string | null;
};

/** One line of an addendum: the work order's scope_items shape. */
export type CustomerVariationLine = {
  line_key: string;
  source: "variation";
  is_variation: true;
  variation_number: number;
  description: string;
  qty: number;
  unit: string;
  hours: number;
};

export type CustomerVariationAddendum = {
  id: string;
  variation_number: number;
  label: string;
  approved_at: string;
  description: string;
  lines: CustomerVariationLine[];
};

const PERTH_DAY = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Perth",
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** "Variation 1 - approved 13 Oct 2026" (the approval day in Perth). */
export function customerVariationLabel(
  variationNumber: number,
  approvedAt: string,
): string {
  const at = new Date(approvedAt);
  const day = Number.isFinite(at.getTime())
    ? PERTH_DAY.format(at).replace(/\./g, "")
    : null;
  return day
    ? `Variation ${variationNumber} - approved ${day}`
    : `Variation ${variationNumber}`;
}

/**
 * The task lines of an approved variation, in the work order's scope_items
 * shape. A task with no quantity of its own carries its hours as the quantity
 * in hours, as the quote's hour-priced lines do, so a trade reads the time.
 */
export function customerVariationLines(
  variationNumber: number,
  tasks: unknown,
): CustomerVariationLine[] {
  return (Array.isArray(tasks) ? tasks : []).flatMap((task: any, i: number) => {
    if (!task || typeof task !== "object" || Array.isArray(task)) return [];
    const hours = Number(task.hours);
    const qty = task.qty === null || task.qty === undefined
      ? null
      : Number(task.qty);
    const unit = typeof task.unit === "string" && task.unit.trim()
      ? task.unit.trim()
      : null;
    const ownQty = qty !== null && Number.isFinite(qty) && unit !== null;
    return [{
      line_key: `variation:${variationNumber}:${i}`,
      source: "variation" as const,
      is_variation: true as const,
      variation_number: variationNumber,
      description: String(task.description ?? ""),
      qty: ownQty ? qty : hours,
      unit: ownQty ? unit : "hrs",
      hours,
    }];
  });
}

/** The addenda of a work order: its approved customer variations, in order. */
export function customerVariationAddenda(
  rows: any[],
  workOrderId: string | null,
): CustomerVariationAddendum[] {
  if (!workOrderId) return [];
  return rows
    .filter((v) =>
      v.status === "approved" && v.work_order_id === workOrderId &&
      Number.isInteger(v.variation_number)
    )
    .sort((a, b) => a.variation_number - b.variation_number)
    .map((v) => ({
      id: v.id,
      variation_number: v.variation_number,
      label: customerVariationLabel(v.variation_number, v.approved_at),
      approved_at: v.approved_at,
      description: v.description,
      lines: customerVariationLines(v.variation_number, v.tasks),
    }));
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
  /** Set by the office correction: what the email it replaces said. */
  correction?: {
    previousDescription: string;
    previousAmountEx: number | null;
  } | null;
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
  const correction = input.correction ?? null;
  const amountText = (value: number | null) =>
    value === null ? "Not given" : `$${money(value).toFixed(2)}`;
  const subject = noDashes(
    `${
      correction ? "Correction: work" : "Work"
    } order variation on ${job}${where}`,
  );
  const facts: Array<[string, string]> = [
    ["Job", `${job}${where}`],
    ["Work order", input.woNumber || "No approved work order yet"],
    ["Trade", input.tradeName || "Unknown"],
    ["Trade invoice", input.invoiceNumber || "Not numbered yet"],
    ["Variation", input.description],
    ["Variation amount (ex GST)", amountText(input.amountEx)],
  ];
  if (correction) {
    facts.push(
      ["Variation was", correction.previousDescription],
      [
        "Variation amount was (ex GST)",
        amountText(correction.previousAmountEx),
      ],
    );
  }
  if (input.figures && input.figures.agreed_ex !== null) {
    facts.push(
      ["Agreed labour (ex GST)", `$${input.figures.agreed_ex.toFixed(2)}`],
    );
    if (input.figures.customer_variation_count > 0) {
      facts.push(
        [
          "Approved customer variations (ex GST)",
          `$${input.figures.customer_variations_ex.toFixed(2)}`,
        ],
        [
          "Agreed including variations (ex GST)",
          `$${(input.figures.agreed_total_ex ?? 0).toFixed(2)}`,
        ],
      );
    }
    facts.push(
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
  const opening = correction
    ? "Correction: the office has corrected a work order variation reported earlier. This replaces the earlier email."
    : "A trade has reported a variation to the work order on their invoice.";
  const intros: Record<"finance" | "admin", string> = {
    finance: `${opening} Please check it before the invoice is paid.`,
    admin:
      `${opening} Please update the job and follow up with the client if needed.`,
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
        // No closing name: send-outlook-email appends "Kind regards," and the
        // admin@ SecureWorks Group card, the one sign-off.
        `</table>`,
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
  "id, org_id, job_id, wo_number, kind, status, scope_items, special_instructions, scheduled_date, site_address, agreed_labour_ex, approved_at, approved_by, approved_via, sealed_content_hash, origin, quote_filled_at, hand_edited_at, created_at, updated_at";

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
  return rows.find((r) => r.status === "approved") || null;
}
function draftOf(rows: any[]) {
  return rows.find((r) => r.status === "draft") || null;
}

async function readCostLanes(
  client: any,
  lineIds: string[],
): Promise<Map<string, string>> {
  const lanes = new Map<string, string>();
  for (let i = 0; i < lineIds.length; i += 100) {
    const { data, error } = await client.from("v_trade_charge_resolved")
      .select("line_id, cost_lane")
      .in("line_id", lineIds.slice(i, i + 100));
    if (error) {
      fail(500, "labour_unreadable", "Trade labour could not be read");
    }
    for (const row of data || []) {
      lanes.set(String(row.line_id), String(row.cost_lane || ""));
    }
  }
  return lanes;
}

async function readWorkOrderLines(
  client: any,
  jobIds: string[],
  opts: { linkedOnly?: boolean } = {},
): Promise<WorkOrderLine[]> {
  const out: WorkOrderLine[] = [];
  for (let i = 0; i < jobIds.length; i += 25) {
    const chunk = jobIds.slice(i, i + 25);
    let offset = 0;
    while (true) {
      let q = client.from("trade_invoice_lines")
        .select(
          "id, trade_invoice_id, job_id, job_work_order_id, line_type, description, total_hours, work_order_hours, line_total_ex, override_amount, trade_invoices!inner(id, user_id, invoice_number, status, submitted_at, users:user_id(name))",
        )
        .in("job_id", chunk);
      if (opts.linkedOnly) q = q.not("job_work_order_id", "is", null);
      const { data, error } = await q
        .order("id", { ascending: true })
        .range(offset, offset + 999);
      if (error) {
        fail(500, "labour_unreadable", "Trade labour could not be read");
      }
      for (const row of data || []) {
        const inv = Array.isArray(row.trade_invoices)
          ? row.trade_invoices[0]
          : row.trade_invoices;
        const hours = row.work_order_hours ?? row.total_hours;
        out.push({
          trade_invoice_line_id: row.id,
          trade_invoice_id: row.trade_invoice_id,
          work_order_id: row.job_work_order_id ?? null,
          job_id: row.job_id,
          user_id: inv?.user_id ?? null,
          trade_name: inv?.users?.name ?? null,
          invoice_number: inv?.invoice_number ?? null,
          invoice_status: String(inv?.status || ""),
          submitted_at: inv?.submitted_at ?? null,
          line_type: row.line_type ?? null,
          description: row.description ?? null,
          hours: hours === null || hours === undefined ? null : Number(hours),
          amount_ex: money(row.override_amount ?? row.line_total_ex),
          cost_lane: "unclassified",
          counted: false,
        });
      }
      if (!data || data.length < 1000) break;
      offset += 1000;
    }
  }
  const lanes = await readCostLanes(
    client,
    out.map((l) => l.trade_invoice_line_id),
  );
  for (const line of out) {
    line.cost_lane = lanes.get(line.trade_invoice_line_id) || "unclassified";
    line.counted = workOrderLineIsLabour(line) &&
      JOB_WORK_ORDER_BILLED_INVOICE_STATUSES.has(line.invoice_status);
  }
  return out;
}

const VARIATION_COLUMNS =
  "id, job_id, work_order_id, trade_invoice_id, description, amount_ex, created_at";
const VARIATION_STAFF_COLUMNS =
  `${VARIATION_COLUMNS}, reported_by, original_description, original_amount_ex, corrected_by, corrected_at`;

async function readVariations(client: any, jobIds: string[]): Promise<any[]> {
  const out: any[] = [];
  for (let i = 0; i < jobIds.length; i += 25) {
    const { data, error } = await client.from("work_order_variations")
      .select(
        `${VARIATION_STAFF_COLUMNS}, users:reported_by(name), trade_invoices:trade_invoice_id(status)`,
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
    for (const row of data || []) {
      const inv = Array.isArray(row.trade_invoices)
        ? row.trade_invoices[0]
        : row.trade_invoices;
      const { trade_invoices: _inv, ...variation } = row;
      out.push({
        ...variation,
        counted: JOB_WORK_ORDER_BILLED_INVOICE_STATUSES.has(
          String(inv?.status || ""),
        ),
      });
    }
  }
  return out;
}

/**
 * Customer variations (work_order_customer_variations). Office reads take
 * every column; the trade read takes CUSTOMER_VARIATION_TRADE_COLUMNS, which
 * names no money column at all.
 */
export const CUSTOMER_VARIATION_COLUMNS =
  "id, org_id, job_id, work_order_id, variation_number, status, description, tasks, trade_allocation_ex, customer_price_ex, created_by, approved_at, approved_by, approved_via, sealed_content_hash, cancelled_at, cancelled_by, cancel_reason, created_at, updated_at";
export const CUSTOMER_VARIATION_TRADE_COLUMNS =
  "id, job_id, work_order_id, variation_number, status, description, tasks, approved_at";

export async function readCustomerVariations(
  client: any,
  jobIds: string[],
): Promise<any[]> {
  const out: any[] = [];
  for (let i = 0; i < jobIds.length; i += 25) {
    const { data, error } = await client.from("work_order_customer_variations")
      .select(CUSTOMER_VARIATION_COLUMNS)
      .in("job_id", jobIds.slice(i, i + 25))
      .order("created_at", { ascending: true });
    if (error) {
      fail(
        500,
        "customer_variations_unreadable",
        "Customer variations could not be read",
      );
    }
    out.push(...(data || []));
  }
  return out;
}

function nullableMoney(value: unknown): number | null {
  return value === null || value === undefined ? null : money(value);
}

/** One customer variation as the office reads it. */
export function shapeCustomerVariation(v: any) {
  const tasks = Array.isArray(v.tasks) ? v.tasks : [];
  return {
    id: v.id,
    job_id: v.job_id,
    status: v.status,
    work_order_id: v.work_order_id ?? null,
    variation_number: v.variation_number ?? null,
    label: v.status === "approved" && Number.isInteger(v.variation_number)
      ? customerVariationLabel(v.variation_number, v.approved_at)
      : null,
    description: v.description,
    tasks,
    hours_total: Math.round(
      tasks.reduce((s: number, t: any) => s + (Number(t?.hours) || 0), 0) *
        100,
    ) / 100,
    trade_allocation_ex: nullableMoney(v.trade_allocation_ex),
    customer_price_ex: nullableMoney(v.customer_price_ex),
    created_by: v.created_by ?? null,
    created_at: v.created_at,
    updated_at: v.updated_at,
    approved_at: v.approved_at ?? null,
    approved_by: v.approved_by ?? null,
    approved_via: v.approved_via ?? null,
    cancelled_at: v.cancelled_at ?? null,
    cancelled_by: v.cancelled_by ?? null,
    cancel_reason: v.cancel_reason ?? null,
  };
}

/** The office's addenda: the trade's addenda plus what each costs and charges. */
function staffAddenda(rows: any[], workOrderId: string | null) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return customerVariationAddenda(rows, workOrderId).map((a) => {
    const row = byId.get(a.id);
    return {
      ...a,
      approved_by: row?.approved_by ?? null,
      hours_total: Math.round(
        a.lines.reduce((s, l) => s + (Number(l.hours) || 0), 0) * 100,
      ) / 100,
      trade_allocation_ex: nullableMoney(row?.trade_allocation_ex),
      customer_price_ex: nullableMoney(row?.customer_price_ex),
    };
  });
}

function figuresFor(
  live: any,
  lines: WorkOrderLine[],
  variations: any[],
  customerVariations: any[] = [],
) {
  return computeWorkOrderFigures({
    agreedEx: live?.agreed_labour_ex ?? null,
    approved: !!live,
    lines,
    variations: variations.map((v) => ({
      amount_ex: v.amount_ex === null || v.amount_ex === undefined
        ? null
        : Number(v.amount_ex),
      work_order_id: v.work_order_id,
      counted: v.counted === true,
    })),
    customerVariations: customerVariations
      .filter((v) => live && v.work_order_id === live.id)
      .map((v) => ({
        status: String(v.status || ""),
        work_order_id: v.work_order_id ?? null,
        trade_allocation_ex: nullableMoney(v.trade_allocation_ex),
        customer_price_ex: nullableMoney(v.customer_price_ex),
      })),
  });
}

function invoicesFrom(lines: WorkOrderLine[], variations: any[]) {
  const byInvoice = new Map<string, any>();
  for (const l of lines) {
    if (!l.work_order_id) continue;
    const cur = byInvoice.get(l.trade_invoice_id) || {
      trade_invoice_id: l.trade_invoice_id,
      invoice_number: l.invoice_number,
      status: l.invoice_status,
      counted: JOB_WORK_ORDER_BILLED_INVOICE_STATUSES.has(l.invoice_status),
      trade_user_id: l.user_id,
      trade_name: l.trade_name,
      submitted_at: l.submitted_at,
      amount_ex: 0,
      hours: 0,
      has_variation: false,
    };
    if (workOrderLineIsLabour(l)) {
      cur.amount_ex = money(cur.amount_ex + l.amount_ex);
      cur.hours = Math.round((cur.hours + (l.hours || 0)) * 100) / 100;
    }
    byInvoice.set(l.trade_invoice_id, cur);
  }
  for (const v of variations) {
    const cur = byInvoice.get(v.trade_invoice_id);
    if (cur) cur.has_variation = true;
  }
  return [...byInvoice.values()].sort((a, b) =>
    String(a.submitted_at || "").localeCompare(String(b.submitted_at || ""))
  );
}

/**
 * The labour each invoice bills in these lines, ex GST, by the work order's
 * own labour rule (workOrderLineIsLabour), whatever the invoice's status.
 */
function labourByInvoice(lines: WorkOrderLine[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) {
    if (!workOrderLineIsLabour(l)) continue;
    out.set(
      l.trade_invoice_id,
      money((out.get(l.trade_invoice_id) ?? 0) + l.amount_ex),
    );
  }
  return out;
}

/**
 * A variation is part of the labour its invoice bills on the job. This is the
 * one test of a variation that is larger than that labour: it refuses a report
 * or a correction, and it is the flag on a variation already recorded (its
 * draft invoice was replaced by one that bills less).
 */
function variationOverInvoiceLabour(
  amountEx: unknown,
  invoiceLabourEx: number,
): boolean {
  return amountEx !== null && amountEx !== undefined &&
    money(amountEx) > money(invoiceLabourEx);
}

function shapeVariation(v: any, invoiceLabourEx: number) {
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
    counted: v.counted === true,
    over_invoice_labour: variationOverInvoiceLabour(
      v.amount_ex,
      invoiceLabourEx,
    ),
    created_at: v.created_at,
    corrected_at: v.corrected_at ?? null,
    corrected_by: v.corrected_by ?? null,
    original_description: v.corrected_at
      ? v.original_description ?? null
      : null,
    original_amount_ex: v.corrected_at && v.original_amount_ex !== null &&
        v.original_amount_ex !== undefined
      ? money(v.original_amount_ex)
      : null,
  };
}

// ── Staff: read one job's work order ─────────────────────────────────────────

// ── Filling a draft from the accepted quote ──────────────────────────────────

export type JobWorkOrderQuoteFill = {
  filled: boolean;
  reason: QuoteFillOutcome["reason"] | "fill_failed";
  scope_revision_id: string | null;
  needs_review: boolean | null;
  code?: string;
};

// Never fails the caller: opening, reading or backfilling a work order goes
// on when the quote cannot be read, and the reason is reported instead.
async function fillDraftFromQuote(
  client: any,
  jobId: string,
): Promise<{ summary: JobWorkOrderQuoteFill; workOrder: any | null }> {
  try {
    const outcome = await fillJobWorkOrderDraftFromQuote(client, jobId);
    return {
      summary: {
        filled: outcome.filled,
        reason: outcome.reason,
        scope_revision_id: outcome.scope_revision_id ?? null,
        needs_review: outcome.needs_review ?? null,
      },
      workOrder: outcome.filled ? outcome.work_order : null,
    };
  } catch (e) {
    const code = e instanceof QuoteFillError ? e.code : "fill_failed";
    console.error(
      "[ops-api] job work order: draft not filled from the quote:",
      jobId,
      code,
      (e as Error)?.message,
    );
    return {
      summary: {
        filled: false,
        reason: "fill_failed",
        scope_revision_id: null,
        needs_review: null,
        code,
      },
      workOrder: null,
    };
  }
}

export async function readJobWorkOrder(
  client: any,
  params: {
    jobId?: string | null;
    workOrderId?: string | null;
    /** Fill an untouched draft from the accepted quote. Only a staff session
     *  or the ops server key; any other read writes nothing. */
    fillFromQuote?: boolean;
  },
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
  const eligible = JOB_WORK_ORDER_JOB_TYPES.has(String(job.type || ""));
  // Every draft is read by staff before it can be approved (approval needs
  // the draft's updated_at as read), so an untouched draft is filled from the
  // accepted quote here, once, and the read returns the filled draft.
  let quoteFill: JobWorkOrderQuoteFill | null = null;
  const untouched = params.fillFromQuote === true && eligible &&
      !liveOf(rows)
    ? draftOf(rows)
    : null;
  if (untouched && jobWorkOrderDraftIsUntouched(untouched)) {
    const fill = await fillDraftFromQuote(client, job.id);
    quoteFill = fill.summary;
    if (fill.workOrder) rows[rows.indexOf(untouched)] = fill.workOrder;
  }
  const live = liveOf(rows);
  const draft = draftOf(rows);
  const [lines, variations, customerVariations, autoIssueOn] = await Promise
    .all([
      readWorkOrderLines(client, [job.id]),
      readVariations(client, [job.id]),
      readCustomerVariations(client, [job.id]),
      readFlag(client, JOB_WORK_ORDER_AUTO_ISSUE_FLAG),
    ]);
  const linked = lines.filter((l) => l.work_order_id);
  const before = lines.filter((l) => !l.work_order_id && l.counted);
  const invoiceLabour = labourByInvoice(lines);
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
    eligible,
    work_order: live || draft || null,
    live_work_order: live,
    draft_work_order: draft,
    figures: figuresFor(live, linked, variations, customerVariations),
    addenda: staffAddenda(customerVariations, live?.id ?? null),
    invoices: invoicesFrom(linked, variations),
    lines: linked,
    labour_before_approval: {
      amount_ex: money(before.reduce((s, l) => s + l.amount_ex, 0)),
      line_count: before.length,
      note:
        "Labour billed on this job with no approved work order to count it against. It links and counts when the work order is approved.",
    },
    variations: variations.map((v) =>
      shapeVariation(v, invoiceLabour.get(v.trade_invoice_id) ?? 0)
    ),
    customer_variations: customerVariations.map(shapeCustomerVariation),
    quote_fill: quoteFill,
    needs_checking: jobWorkOrderNeedsChecking(live || draft, autoIssueOn),
  };
}

// ── Staff: list job work orders ──────────────────────────────────────────────

export async function listJobWorkOrders(client: any, params: URLSearchParams) {
  const status = String(params.get("status") || "").trim();
  const type = String(params.get("type") || "").trim();
  const jobId = params.get("job_id");
  if (status && !["draft", "approved"].includes(status)) {
    fail(400, "invalid_status", "status must be draft or approved");
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
    if (status) q = q.eq("status", status);
    const { data, error } = await q;
    if (error) {
      fail(500, "work_orders_unreadable", "Job work orders could not be read");
    }
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
    offset += 1000;
  }
  const jobIds = [...new Set(rows.map((r) => String(r.job_id)))];
  const [lines, variations, customerVariations] = await Promise.all([
    readWorkOrderLines(client, jobIds, { linkedOnly: true }),
    readVariations(client, jobIds),
    readCustomerVariations(client, jobIds),
  ]);
  const work_orders = rows.map((r) => {
    const job = Array.isArray(r.jobs) ? r.jobs[0] : r.jobs;
    const isLive = r.status === "approved";
    const jobLines = lines.filter((l) => l.job_id === r.job_id);
    const jobVariations = variations.filter((v) => v.job_id === r.job_id);
    const jobCustomerVariations = customerVariations.filter((v) =>
      v.job_id === r.job_id
    );
    const { jobs: _jobs, ...wo } = r;
    return {
      ...wo,
      job_number: job?.job_number ?? null,
      client_name: job?.client_name ?? null,
      job_type: job?.type ?? null,
      job_status: job?.status ?? null,
      site_suburb: job?.site_suburb ?? null,
      figures: isLive
        ? figuresFor(r, jobLines, jobVariations, jobCustomerVariations)
        : null,
    };
  });
  return {
    schema: "job-work-orders.v1",
    kind: "job",
    work_orders,
    total: work_orders.length,
  };
}

// ── Staff: open (or edit) the job's draft ────────────────────────────────────

export async function createJobWorkOrder(client: any, body: any) {
  const jobId = requireUuid(body?.job_id, "job_id");
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
  if (liveOf(rows)) {
    fail(
      409,
      "work_order_sealed",
      "This job's work order is approved and sealed. Later change is recorded as a variation.",
    );
  }
  let draft = draftOf(rows);
  const created = !draft;
  if (!draft) {
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
    },
  );
  // Lines or an agreed amount sent with the call are kept as given; otherwise
  // the draft opens filled from the accepted quote.
  let quoteFill: JobWorkOrderQuoteFill | null = null;
  if (jobWorkOrderDraftIsUntouched(draft)) {
    const fill = await fillDraftFromQuote(client, jobId);
    quoteFill = fill.summary;
    if (fill.workOrder) draft = fill.workOrder;
  }
  return { created, work_order: draft, quote_fill: quoteFill };
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
  const id = requireUuid(body?.id, "id");
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
      "This work order is approved and sealed. Later change is recorded as a variation.",
    );
  }
  if (body?.status !== undefined && body.status !== "draft") {
    fail(
      400,
      "invalid_status",
      "A draft work order's status changes only through approve_work_order.",
    );
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
  "P0002": [404, "work_order_not_found"],
  "WO409": [409, "stale_review"],
};

export async function approveJobWorkOrder(
  client: any,
  body: any,
  approver: WorkOrderApprover | null,
) {
  const id = requireUuid(body?.work_order_id, "work_order_id");
  if (!approver) {
    fail(
      403,
      "approver_identity_missing",
      "Approving needs Shaun's own signed-in session.",
    );
  }
  if (
    approver.via === "terminal" &&
    !(await readFlag(client, WORK_ORDER_TERMINAL_APPROVAL_FLAG))
  ) {
    fail(
      403,
      "terminal_approval_switched_off",
      "Approving from the terminal is switched off (feature flag work_order_terminal_approval_v1). Approve from Shaun's signed-in session.",
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
  const expected = body?.expected_updated_at;
  if (typeof expected !== "string" || !Number.isFinite(Date.parse(expected))) {
    fail(
      400,
      "expected_updated_at_required",
      "Read the draft again and send its updated_at as expected_updated_at. Approving seals only the draft you read.",
    );
  }
  const wo = await readWorkOrder(client, id);
  if (wo.kind !== "job") {
    fail(422, "not_a_job_work_order", "Only a job work order is approved");
  }
  if (wo.status !== "draft") {
    fail(409, "not_a_draft", `This work order is ${wo.status}`);
  }
  const { data, error } = await client.rpc("approve_job_work_order", {
    p_work_order_id: id,
    p_approver: approver.userId,
    p_via: approver.via,
    p_expected_updated_at: expected,
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
  }, approver.userId);
  return { work_order: data };
}

// ── Staff: backfill (switched off) ───────────────────────────────────────────

// Each apply also fills untouched drafts from their accepted quotes, oldest
// first, at most fill_limit per call (default 100, at most 200; 80 fencing and
// patio jobs were open on 13 Oct 2026). A draft is left untouched, and tried
// again on the next run, only when its quote gives no work order lines or the
// job has no accepted quote (a quote with lines but no labour figure is filled
// with lines only); `remaining` says how many were not tried. A dry run fills
// nothing and counts them.
export const BACKFILL_QUOTE_FILL_DEFAULT_LIMIT = 100;
export const BACKFILL_QUOTE_FILL_MAX_LIMIT = 200;

async function readUntouchedJobDrafts(client: any): Promise<any[]> {
  const { data, error } = await client.from("work_orders")
    .select(
      "id, job_id, kind, status, scope_items, agreed_labour_ex, created_at",
    )
    .eq("kind", "job")
    .eq("status", "draft")
    // A draft with an agreed amount is never a candidate, so it is not read.
    .is("agreed_labour_ex", null)
    .order("created_at", { ascending: true });
  if (error) {
    fail(500, "drafts_unreadable", "The draft work orders could not be read");
  }
  return (data || []).filter(jobWorkOrderDraftIsUntouched);
}

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
  const untouched = await readUntouchedJobDrafts(client);
  if (!apply) {
    return {
      ...data,
      quote_fill: { dry_run: true, untouched_drafts: untouched.length },
      auto_issue: {
        dry_run: true,
        switched_on: await readFlag(client, JOB_WORK_ORDER_AUTO_ISSUE_FLAG),
      },
    };
  }
  const requested = Number(body?.fill_limit);
  const limit = Number.isInteger(requested) && requested > 0
    ? Math.min(requested, BACKFILL_QUOTE_FILL_MAX_LIMIT)
    : BACKFILL_QUOTE_FILL_DEFAULT_LIMIT;
  const autoIssueOn = await readFlag(client, JOB_WORK_ORDER_AUTO_ISSUE_FLAG);
  const notFilled: Record<string, number> = {};
  const notIssued: Record<string, number> = {};
  let filled = 0;
  let issued = 0;
  const batch = untouched.slice(0, limit);
  for (const wo of batch) {
    const { summary } = await fillDraftFromQuote(client, String(wo.job_id));
    if (summary.filled) filled++;
    else notFilled[summary.reason] = (notFilled[summary.reason] || 0) + 1;
    // A draft this run filled goes to the trades straight away while
    // automatic issue is on, by the same rule as every other job.
    if (summary.filled && autoIssueOn) {
      const r = await autoIssueJobWorkOrderForJob(client, String(wo.job_id), {
        flagOn: true,
      });
      if (r.issued) issued++;
      else notIssued[r.reason] = (notIssued[r.reason] || 0) + 1;
    }
  }
  return {
    ...data,
    quote_fill: {
      dry_run: false,
      untouched_drafts: untouched.length,
      attempted: batch.length,
      filled,
      not_filled: notFilled,
      remaining: untouched.length - batch.length,
    },
    auto_issue: autoIssueOn
      ? { switched_on: true, issued, not_issued: notIssued }
      : { switched_on: false, issued: 0, not_issued: {} },
  };
}

// ── System: fill and issue automatically (switched off) ─────────────────────

export type JobWorkOrderAutoIssueReason =
  | "issued"
  | "switched_off"
  | "not_eligible"
  | "job_not_open"
  | "already_approved"
  | "no_draft"
  | "not_filled"
  | "hand_edited"
  | "filled_before_auto_issue"
  | "agreed_labour_missing"
  | "draft_changed"
  | "issue_failed";

export type JobWorkOrderAutoIssue = {
  job_id: string;
  work_order_id: string | null;
  issued: boolean;
  reason: JobWorkOrderAutoIssueReason;
  /** The quote fill this call made first, else null. */
  quote_fill: JobWorkOrderQuoteFill | null;
  /** How many of the issued lines the fill flagged for the office. */
  needs_checking_lines: number;
  code?: string;
};

const AUTO_ISSUE_ERRORS: Record<string, [JobWorkOrderAutoIssueReason, string]> =
  {
    "42501": ["switched_off", "auto_issue_switched_off"],
    "WO409": ["draft_changed", "stale_read"],
    "WO423": ["hand_edited", "not_issuable"],
    "23514": ["issue_failed", "work_order_not_ready"],
    "P0002": ["no_draft", "work_order_not_found"],
  };

/**
 * Fills the job's draft from the accepted quote when nobody has written into
 * it, then issues it to the trades with no human approval (approved_via
 * 'auto'), sealed as an approval seals it. Only while
 * JOB_WORK_ORDER_AUTO_ISSUE_FLAG is on, only for an open fencing or patio job,
 * and only for the draft the quote fill wrote that nobody has edited since
 * (the database checks the last two again, under the row lock). Lines the
 * fill flagged for review never stop it: they stay on the work order for the
 * office (jobWorkOrderNeedsChecking). A draft edited by hand, a quote with no
 * labour figure, and a job with no accepted quote wait for the approver.
 * Never throws: every outcome is a reason.
 */
export async function autoIssueJobWorkOrderForJob(
  client: any,
  jobId: string,
  opts: { flagOn?: boolean } = {},
): Promise<JobWorkOrderAutoIssue> {
  const out = (
    reason: JobWorkOrderAutoIssueReason,
    extra: Partial<JobWorkOrderAutoIssue> = {},
  ): JobWorkOrderAutoIssue => ({
    job_id: jobId,
    work_order_id: null,
    issued: reason === "issued",
    reason,
    quote_fill: null,
    needs_checking_lines: 0,
    ...extra,
  });
  try {
    const flagOn = opts.flagOn ??
      await readFlag(client, JOB_WORK_ORDER_AUTO_ISSUE_FLAG);
    if (!flagOn) return out("switched_off");
    const job = await readJob(client, requireUuid(jobId, "job_id"));
    if (!JOB_WORK_ORDER_JOB_TYPES.has(String(job.type || ""))) {
      return out("not_eligible");
    }
    if (!JOB_WORK_ORDER_OPEN_STATUSES.has(String(job.status || ""))) {
      return out("job_not_open");
    }
    const rows = await readJobWorkOrders(client, job.id);
    const live = liveOf(rows);
    if (live) return out("already_approved", { work_order_id: live.id });
    let draft = draftOf(rows);
    if (!draft) return out("no_draft");
    let quoteFill: JobWorkOrderQuoteFill | null = null;
    if (jobWorkOrderDraftIsUntouched(draft) && !draft.hand_edited_at) {
      const fill = await fillDraftFromQuote(client, job.id);
      quoteFill = fill.summary;
      if (!fill.workOrder) {
        return out(
          fill.summary.reason === "draft_changed"
            ? "draft_changed"
            : "not_filled",
          {
            work_order_id: draft.id,
            quote_fill: quoteFill,
            ...(fill.summary.code ? { code: fill.summary.code } : {}),
          },
        );
      }
      draft = fill.workOrder;
    }
    const held = (reason: JobWorkOrderAutoIssueReason) =>
      out(reason, { work_order_id: draft.id, quote_fill: quoteFill });
    if (draft.hand_edited_at) return held("hand_edited");
    const items = Array.isArray(draft.scope_items) ? draft.scope_items : [];
    if (items.length === 0) return held("not_filled");
    if (!draft.quote_filled_at) return held("filled_before_auto_issue");
    if (
      draft.agreed_labour_ex === null || draft.agreed_labour_ex === undefined
    ) {
      return held("agreed_labour_missing");
    }
    const { data, error } = await client.rpc("auto_issue_job_work_order", {
      p_work_order_id: draft.id,
      p_expected_updated_at: draft.updated_at,
    });
    if (error) {
      const [reason, code] = AUTO_ISSUE_ERRORS[String(error.code || "")] ??
        ["issue_failed", "issue_failed"];
      console.error(
        "[job-work-orders] automatic issue refused:",
        job.id,
        String(error.code || ""),
        error.message,
      );
      return out(reason, {
        work_order_id: draft.id,
        quote_fill: quoteFill,
        code,
      });
    }
    const needsChecking = items.filter((i: any) => i?.needs_review === true)
      .length;
    // Ids and counts only (job_events is readable by every signed-in user of
    // the org, trades included).
    await logJobEvent(client, job.id, "job_work_order_auto_issued", {
      work_order_id: draft.id,
      wo_number: data?.wo_number ?? draft.wo_number,
      line_count: items.length,
      needs_checking_lines: needsChecking,
    });
    return out("issued", {
      work_order_id: draft.id,
      quote_fill: quoteFill,
      needs_checking_lines: needsChecking,
    });
  } catch (e) {
    const code = e instanceof JobWorkOrderError ? e.code : "issue_failed";
    console.error(
      "[job-work-orders] automatic issue failed:",
      jobId,
      code,
      (e as Error)?.message,
    );
    return out("issue_failed", { code });
  }
}

export const AUTO_ISSUE_SWEEP_DEFAULT_LIMIT = 25;
export const AUTO_ISSUE_SWEEP_MAX_LIMIT = 100;
/** An untouched draft is tried by the sweep for this long after it opened;
 *  one with no accepted quote by then waits for the office. */
export const AUTO_ISSUE_SWEEP_UNTOUCHED_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

const SWEEP_COLUMNS =
  `id, job_id, kind, status, scope_items, agreed_labour_ex, quote_filled_at, hand_edited_at, created_at, jobs:job_id!inner(type, status)`;

/**
 * The sweep the pg_cron job (every 2 minutes) posts while the flag is on, and
 * the catch-all behind every way a job becomes approved (send-quote's
 * acceptance, a status change, a stage move from the CRM). Candidates are
 * drafts nobody edited by hand on open fencing and patio jobs: every one the
 * quote fill wrote with an agreed labour figure, then untouched drafts opened
 * in the last 3 days, newest first, so a job with no accepted quote is not
 * retried forever ahead of new ones. Writes nothing while the flag is off.
 */
export async function autoIssueJobWorkOrders(
  client: any,
  body: any,
  now: Date = new Date(),
) {
  const flagOn = await readFlag(client, JOB_WORK_ORDER_AUTO_ISSUE_FLAG);
  if (!flagOn) {
    return {
      schema: "job-work-order-auto-issue.v1",
      switched_on: false,
      candidates: 0,
      issued: 0,
      not_issued: {},
      results: [],
    };
  }
  const requested = Number(body?.limit);
  const limit = Number.isInteger(requested) && requested > 0
    ? Math.min(requested, AUTO_ISSUE_SWEEP_MAX_LIMIT)
    : AUTO_ISSUE_SWEEP_DEFAULT_LIMIT;
  const open = [...JOB_WORK_ORDER_OPEN_STATUSES];
  const types = [...JOB_WORK_ORDER_JOB_TYPES];
  const { data: filled, error: filledError } = await client.from("work_orders")
    .select(SWEEP_COLUMNS)
    .eq("kind", "job")
    .eq("status", "draft")
    .is("hand_edited_at", null)
    .not("quote_filled_at", "is", null)
    .not("agreed_labour_ex", "is", null)
    .in("jobs.type", types)
    .in("jobs.status", open)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (filledError) {
    fail(500, "drafts_unreadable", "The draft work orders could not be read");
  }
  const since = new Date(now.getTime() - AUTO_ISSUE_SWEEP_UNTOUCHED_WINDOW_MS)
    .toISOString();
  const { data: fresh, error: freshError } = await client.from("work_orders")
    .select(SWEEP_COLUMNS)
    .eq("kind", "job")
    .eq("status", "draft")
    .is("hand_edited_at", null)
    .is("agreed_labour_ex", null)
    .gte("created_at", since)
    .in("jobs.type", types)
    .in("jobs.status", open)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (freshError) {
    fail(500, "drafts_unreadable", "The draft work orders could not be read");
  }
  const jobIds: string[] = [];
  for (
    const wo of [
      ...(filled || []),
      ...(fresh || []).filter(jobWorkOrderDraftIsUntouched),
    ]
  ) {
    const id = String(wo.job_id);
    if (!jobIds.includes(id)) jobIds.push(id);
  }
  const batch = jobIds.slice(0, limit);
  const results: JobWorkOrderAutoIssue[] = [];
  const notIssued: Record<string, number> = {};
  for (const jobId of batch) {
    const r = await autoIssueJobWorkOrderForJob(client, jobId, {
      flagOn: true,
    });
    results.push(r);
    if (!r.issued) notIssued[r.reason] = (notIssued[r.reason] || 0) + 1;
  }
  return {
    schema: "job-work-order-auto-issue.v1",
    switched_on: true,
    candidates: jobIds.length,
    issued: results.filter((r) => r.issued).length,
    not_issued: notIssued,
    results,
  };
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
  // Approved addenda only, and never a money column: the select names none.
  let addenda: CustomerVariationAddendum[] = [];
  if (live) {
    const { data: approved, error: addendaErr } = await client.from(
      "work_order_customer_variations",
    ).select(CUSTOMER_VARIATION_TRADE_COLUMNS)
      .eq("job_id", jobId).eq("work_order_id", live.id).eq("status", "approved")
      .order("variation_number", { ascending: true });
    if (addendaErr) {
      fail(
        500,
        "customer_variations_unreadable",
        "The work order's variations could not be read",
      );
    }
    addenda = customerVariationAddenda(approved || [], live.id);
  }
  const { data: mine, error } = await client.from("work_order_variations")
    .select("id, description, created_at, trade_invoice_id")
    .eq("job_id", jobId).eq("reported_by", viewerId).order("created_at", {
      ascending: true,
    });
  if (error) {
    fail(500, "variations_unreadable", "Your variations could not be read");
  }
  return {
    schema: TRADE_JOB_WORK_ORDER_SCHEMA,
    job_id: jobId,
    work_order: live
      ? projectTradeJobWorkOrder(live, job, redact, addenda)
      : null,
    reason: live ? null : "no_approved_work_order",
    can_report_variation: JOB_WORK_ORDER_JOB_TYPES.has(String(job.type || "")),
    my_variations: (mine || []).map((v: any) => ({
      id: v.id,
      trade_invoice_id: v.trade_invoice_id,
      description: v.description,
      created_at: v.created_at,
    })),
  };
}

// ── Trade: report a variation on the trade's own invoice ─────────────────────

export type VariationEmailSender = (
  email: VariationEmail,
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

function parseVariationDescription(value: unknown): string {
  const description = typeof value === "string" ? value.trim() : "";
  if (!description || description.length > MAX_VARIATION_TEXT) {
    fail(
      400,
      "invalid_description",
      `Describe the variation in 1 to ${MAX_VARIATION_TEXT} characters`,
    );
  }
  return description;
}

function parseVariationAmount(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) {
    fail(400, "invalid_amount_ex", "amount_ex must be zero or more");
  }
  return money(n);
}

function requireVariationWithinInvoiceLabour(
  amountEx: number | null,
  invoiceLabourEx: number,
) {
  if (variationOverInvoiceLabour(amountEx, invoiceLabourEx)) {
    fail(
      422,
      "variation_over_invoice",
      `The variation amount is more than the labour this invoice bills on this job ($${
        money(invoiceLabourEx).toFixed(2)
      } ex GST). Check the amount.`,
    );
  }
}

/**
 * The work order's figures for a variation email, from the job's lines as
 * already read; null when the variations are unreadable.
 */
async function variationEmailFigures(
  client: any,
  live: any,
  jobId: string,
  jobLines: WorkOrderLine[],
): Promise<WorkOrderFigures | null> {
  if (!live) return null;
  try {
    const [variations, customerVariations] = await Promise.all([
      readVariations(client, [jobId]),
      readCustomerVariations(client, [jobId]),
    ]);
    return figuresFor(
      live,
      jobLines.filter((l) => l.work_order_id),
      variations,
      customerVariations,
    );
  } catch (_e) {
    return null;
  }
}

export async function reportWorkOrderVariation(
  client: any,
  body: any,
  trade: { id: string; orgId: string; name?: string | null },
  deps: { sendEmail: VariationEmailSender; now?: () => number },
) {
  const invoiceId = requireUuid(body?.trade_invoice_id, "trade_invoice_id");
  const jobId = requireUuid(body?.job_id, "job_id");
  const description = parseVariationDescription(body?.description);
  const amountEx = parseVariationAmount(body?.amount_ex);

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

  const jobLines = await readWorkOrderLines(client, [jobId]);
  if (!jobLines.some((l) => l.trade_invoice_id === invoiceId)) {
    fail(422, "job_not_on_invoice", "This invoice has no line for that job");
  }
  requireVariationWithinInvoiceLabour(
    amountEx,
    labourByInvoice(jobLines).get(invoiceId) ?? 0,
  );

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
  }).select(VARIATION_COLUMNS).single();
  let variation = inserted;
  const duplicate = insErr?.code === "23505";
  if (duplicate) {
    const { data: existing } = await client.from("work_order_variations")
      .select(VARIATION_COLUMNS)
      .eq("trade_invoice_id", invoiceId).eq("job_id", jobId).maybeSingle();
    if (
      !existing || existing.description !== description ||
      (existing.amount_ex === null ? null : money(existing.amount_ex)) !==
        amountEx
    ) {
      fail(
        409,
        "variation_exists",
        "A different variation is already recorded for this job on this invoice",
      );
    }
    variation = existing;
  } else if (insErr) {
    fail(500, "variation_not_saved", "The variation could not be saved");
  }

  const emails = buildVariationEmails({
    jobNumber: job.job_number,
    siteSuburb: job.site_suburb,
    woNumber: live?.wo_number ?? null,
    tradeName: trade.name ?? null,
    invoiceNumber: invoice.invoice_number ?? null,
    description,
    amountEx,
    figures: await variationEmailFigures(client, live, jobId, jobLines),
  });
  const emailResults = await recordAndMaybeSendVariationEmails(
    client,
    variation.id,
    emails,
    deps.sendEmail,
    deps.now,
  );
  if (!duplicate) {
    await logJobEvent(client, jobId, "work_order_variation_reported", {
      variation_id: variation.id,
      work_order_id: live?.id ?? null,
      trade_invoice_id: invoiceId,
    }, trade.id);
  }
  return { variation, duplicate, emails: emailResults };
}

// ── Staff: correct a variation (never a trade door) ──────────────────────────

/**
 * The one way a recorded variation changes: office staff correct its amount
 * and description. The first correction keeps what the trade reported
 * (original_description, original_amount_ex); every correction stamps who and
 * when. The figures follow the row, so they are corrected with it. The two
 * ledger emails are replaced by the corrected ones, sent only while the email
 * flag is on.
 */
export async function correctWorkOrderVariation(
  client: any,
  body: any,
  corrector: { actor: string; missing: boolean },
  deps: { sendEmail: VariationEmailSender; now?: () => number },
) {
  const id = requireUuid(body?.variation_id, "variation_id");
  if (corrector.missing) {
    fail(
      403,
      "corrector_identity_missing",
      "A correction records who made it. Sign in, or name the caller with x-sw-actor on a server key call.",
    );
  }
  const { data: current, error } = await client.from("work_order_variations")
    .select(
      `${VARIATION_STAFF_COLUMNS}, users:reported_by(name), trade_invoices:trade_invoice_id(invoice_number, status)`,
    )
    .eq("id", id).maybeSingle();
  if (error) {
    fail(500, "variations_unreadable", "The variation could not be read");
  }
  if (!current) fail(404, "variation_not_found", "Variation not found");

  const previousAmountEx = current.amount_ex === null ||
      current.amount_ex === undefined
    ? null
    : money(current.amount_ex);
  const description = body?.description === undefined
    ? String(current.description)
    : parseVariationDescription(body.description);
  const amountEx = body?.amount_ex === undefined
    ? previousAmountEx
    : parseVariationAmount(body.amount_ex);
  if (description === current.description && amountEx === previousAmountEx) {
    fail(
      400,
      "nothing_to_correct",
      "Give the corrected description or amount_ex",
    );
  }
  const jobLines = await readWorkOrderLines(client, [current.job_id]);
  const invoiceLabourEx =
    labourByInvoice(jobLines).get(current.trade_invoice_id) ?? 0;
  requireVariationWithinInvoiceLabour(amountEx, invoiceLabourEx);
  const job = await readJob(client, current.job_id);
  const live = liveOf(await readJobWorkOrders(client, current.job_id));

  const now = deps.now ?? Date.now;
  const { data: saved, error: saveErr } = await client.from(
    "work_order_variations",
  ).update({
    description,
    amount_ex: amountEx,
    corrected_by: corrector.actor,
    corrected_at: new Date(now()).toISOString(),
    ...(current.corrected_at ? {} : {
      original_description: current.description,
      original_amount_ex: current.amount_ex ?? null,
    }),
  }).eq("id", id).select(VARIATION_STAFF_COLUMNS).maybeSingle();
  if (saveErr || !saved) {
    fail(500, "variation_not_corrected", "The correction could not be saved");
  }

  const invoice = Array.isArray(current.trade_invoices)
    ? current.trade_invoices[0]
    : current.trade_invoices;
  const emails = await recordAndMaybeSendVariationEmails(
    client,
    id,
    buildVariationEmails({
      jobNumber: job.job_number,
      siteSuburb: job.site_suburb,
      woNumber: live?.wo_number ?? null,
      tradeName: current.users?.name ?? null,
      invoiceNumber: invoice?.invoice_number ?? null,
      description,
      amountEx,
      figures: await variationEmailFigures(
        client,
        live,
        current.job_id,
        jobLines,
      ),
      correction: {
        previousDescription: String(current.description),
        previousAmountEx,
      },
    }),
    deps.sendEmail,
    now,
    { replace: true },
  );
  const correctorUser = /^user:([0-9a-f-]{36})$/i.exec(corrector.actor)?.[1];
  await logJobEvent(client, current.job_id, "work_order_variation_corrected", {
    variation_id: id,
    work_order_id: saved.work_order_id ?? null,
    trade_invoice_id: saved.trade_invoice_id,
  }, isUuid(correctorUser) ? correctorUser : null);
  return {
    variation: shapeVariation({
      ...saved,
      users: current.users,
      counted: JOB_WORK_ORDER_BILLED_INVOICE_STATUSES.has(
        String(invoice?.status || ""),
      ),
    }, invoiceLabourEx),
    emails,
  };
}

const VARIATION_EMAIL_COLUMNS =
  "id, variation_id, recipient_role, recipient, subject, body_text, body_html, status, sending_started_at";

/**
 * Whether a ledger row is still owed a send. `failed` always is. `sending` is
 * only once its claim is older than the staleness bound (the worker that held
 * it is gone). `recorded` is owed to the variation's own report call, never to
 * the sweep: a row recorded while the flag was off is not a backlog to send.
 */
function variationEmailOwed(
  row: any,
  nowMs: number,
  includeRecorded: boolean,
): boolean {
  if (row.status === "failed") return true;
  if (row.status === "recorded") return includeRecorded;
  if (row.status === "sending" && row.sending_started_at) {
    return Date.parse(row.sending_started_at) <=
      nowMs - WORK_ORDER_VARIATION_EMAIL_STALE_SENDING_MS;
  }
  return false;
}

/**
 * Claims one owed row and sends it. The claim is a compare-and-set on the
 * exact state that was read (and, for a stale `sending` row, on its claim
 * stamp), so two callers can never both send the same email. The outcome is
 * written only while this call still holds the claim, so it never marks a row
 * a correction has since replaced.
 */
async function claimAndSendVariationEmail(
  client: any,
  row: any,
  sendEmail: VariationEmailSender,
  nowMs: number,
): Promise<string> {
  const claimedAt = new Date(nowMs).toISOString();
  let claim = client.from("work_order_variation_emails")
    .update({
      status: "sending",
      sending_started_at: claimedAt,
      send_error: null,
    })
    .eq("id", row.id).eq("status", row.status);
  if (row.status === "sending") {
    claim = claim.eq("sending_started_at", row.sending_started_at);
  }
  const { data: claimed } = await claim.select("id").maybeSingle();
  if (!claimed) return "claimed_elsewhere";
  let outcome: { ok: true } | { ok: false; error: string };
  try {
    outcome = await sendEmail({
      recipient_role: row.recipient_role,
      recipient: row.recipient,
      subject: row.subject,
      body_text: row.body_text,
      body_html: row.body_html,
    });
  } catch (e) {
    outcome = { ok: false, error: (e as Error)?.message || "send threw" };
  }
  const patch = outcome.ok
    ? { status: "sent", sent_at: new Date().toISOString() }
    : { status: "failed", send_error: outcome.error.slice(0, 500) };
  const { error: updErr } = await client.from("work_order_variation_emails")
    .update(patch).eq("id", row.id).eq("sending_started_at", claimedAt);
  if (updErr) {
    console.error(
      "[job-work-orders] variation email outcome not saved:",
      updErr.message,
    );
  }
  return patch.status;
}

/**
 * One ledger row per recipient (finance, admin), written once. While the
 * feature flag is on, every row this variation still owes is claimed and sent:
 * a first report sends both, and a retry of the same report sends only what is
 * not already sent or in flight. Sends nothing while the flag is off.
 * `replace` (the office correction) overwrites both rows with the corrected
 * emails and owes them afresh, so an earlier email is never sent in their place.
 */
export async function recordAndMaybeSendVariationEmails(
  client: any,
  variationId: string,
  emails: VariationEmail[],
  sendEmail: VariationEmailSender,
  now: () => number = Date.now,
  opts: { replace?: boolean } = {},
) {
  const replace = opts.replace === true;
  const notRecorded = () =>
    emails.map((e) => ({
      recipient_role: e.recipient_role,
      status: "not_recorded",
    }));
  const { error } = await client.from("work_order_variation_emails")
    .upsert(
      emails.map((e) => ({
        variation_id: variationId,
        ...e,
        ...(replace
          ? {
            status: "recorded",
            sending_started_at: null,
            sent_at: null,
            send_error: null,
          }
          : {}),
      })),
      { onConflict: "variation_id,recipient_role", ignoreDuplicates: !replace },
    );
  if (error) {
    console.error(
      "[job-work-orders] variation emails not recorded:",
      error.message,
    );
    return notRecorded();
  }
  const { data: rows, error: readErr } = await client.from(
    "work_order_variation_emails",
  ).select(VARIATION_EMAIL_COLUMNS).eq("variation_id", variationId);
  if (readErr) {
    console.error(
      "[job-work-orders] variation emails not read back:",
      readErr.message,
    );
    return notRecorded();
  }
  const sendOn = await readFlag(client, WORK_ORDER_VARIATION_EMAILS_FLAG);
  const results: Array<{ recipient_role: string; status: string }> = [];
  for (const email of emails) {
    const row = (rows || []).find((r: any) =>
      r.recipient_role === email.recipient_role
    );
    if (!row) {
      results.push({
        recipient_role: email.recipient_role,
        status: "not_recorded",
      });
      continue;
    }
    const status = sendOn && variationEmailOwed(row, now(), true)
      ? await claimAndSendVariationEmail(client, row, sendEmail, now())
      : row.status;
    results.push({ recipient_role: email.recipient_role, status });
  }
  return results;
}

const VARIATION_EMAIL_RESEND_LIMIT = 100;

/**
 * Staff sweep: re-sends variation emails left `failed`, or stuck in `sending`
 * past the staleness bound. Idempotent: a row already sent, in flight, or
 * claimed by another call is left alone. Does nothing while the flag is off.
 */
export async function resendWorkOrderVariationEmails(
  client: any,
  deps: { sendEmail: VariationEmailSender; now?: () => number },
) {
  const now = deps.now ?? Date.now;
  if (!(await readFlag(client, WORK_ORDER_VARIATION_EMAILS_FLAG))) {
    return { sending_on: false, emails: [] };
  }
  const { data: rows, error } = await client.from("work_order_variation_emails")
    .select(VARIATION_EMAIL_COLUMNS)
    .in("status", ["failed", "sending"])
    .order("created_at", { ascending: true })
    .limit(VARIATION_EMAIL_RESEND_LIMIT);
  if (error) {
    fail(
      500,
      "variation_emails_unreadable",
      "The variation emails could not be read",
    );
  }
  const owed = (rows || []).filter((r: any) =>
    variationEmailOwed(r, now(), false)
  );
  const results: Array<
    { id: string; variation_id: string; recipient_role: string; status: string }
  > = [];
  for (const row of owed) {
    results.push({
      id: row.id,
      variation_id: row.variation_id,
      recipient_role: row.recipient_role,
      status: await claimAndSendVariationEmail(
        client,
        row,
        deps.sendEmail,
        now(),
      ),
    });
  }
  return { sending_on: true, emails: results };
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
