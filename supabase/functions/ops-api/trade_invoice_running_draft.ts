// Running weekly invoice draft.
//
// Save stores one hourly draft per person per week. It never submits,
// authorises, pays, or creates a Xero bill. The header uses the same GST and
// super split as every other trade invoice (trade_invoice_money.ts), because
// trade_invoices_super_gst_split_check rejects a super rate of 0. The weekly
// deduction is not applied here; generate_trade_invoice still takes it on
// submit. Keep the merge rules in step with
// secureworks-ux modules/trade-invoice-running-draft.js.
//
// Screen flag: users.trade_details.runningInvoiceDraft === true.
// my_hours reports that as running_invoice_draft.

import {
  hideRetiredCrewWorkOrder,
  RETIRE_CREW_WORK_ORDERS_FLAG,
} from "./crew_invoice_job_work_order.ts";
import { readFlag } from "./job_work_orders.ts";
import {
  calculateTradeInvoiceMoney,
  TradeInvoiceMoneyError,
} from "./trade_invoice_money.ts";
import { draftTradeInvoiceTimeEntry } from "./trade_invoice_time_entry.ts";
import {
  weeklyWorkOrderBusinessDate,
  WORK_ORDER_INVOICE_LIST_STATUSES,
  workOrderIsInvoiceReady,
} from "./trade_invoice_weekly.ts";

export class RunningDraftError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const BLOCKED_KEYS = [
  "submit",
  "send",
  "authorise",
  "authorize",
  "pay",
  "xero",
  "xero_bill_id",
  "xero_status",
  "create_xero",
];
// Same hourly whitelist as my_hours. Cancelled work is not invoiceable.
const ASSIGNMENT_STATUSES = [
  "scheduled",
  "confirmed",
  "in_progress",
  "complete",
];
const RELEASED = ["draft", "failed", "ops-reject"];
const DRAFT_ACTIONS = [
  "save_running_invoice_draft",
  "get_running_invoice_draft",
  "sync_running_invoice_draft",
  "agent_save_running_invoice_draft",
];

const AGENT_ONLY =
  "An agent can only save a draft. It cannot submit, send, authorise, pay, or create a Xero bill.";

export function runningInvoiceDraftEnabled(tradeDetails: unknown): boolean {
  return !!(tradeDetails && typeof tradeDetails === "object" &&
    (tradeDetails as { runningInvoiceDraft?: unknown }).runningInvoiceDraft ===
      true);
}

export function sourceKey(
  line: Record<string, unknown> | null | undefined,
): string {
  if (!line) return "";
  if (line.source_key) return String(line.source_key);
  if (line.work_order_id) return "wo:" + line.work_order_id;
  if (line.assignment_id) return "as:" + line.assignment_id;
  const day = String(
    line.work_date || line.scheduled_date || line.line_date || "",
  );
  if (line.job_id && day) return "job:" + line.job_id + ":" + day.slice(0, 10);
  return "";
}

export function mergeApproved(state: {
  cards?: Array<Record<string, unknown>>;
  dismissed?: string[];
  claimed?: string[];
  suggested?: Array<Record<string, unknown>>;
}): {
  cards: Array<Record<string, unknown>>;
  added: string[];
  dismissed: string[];
} {
  const cards = JSON.parse(JSON.stringify(state.cards || [])) as Array<
    Record<string, unknown>
  >;
  const dismissed = new Set(
    (state.dismissed || []).filter(Boolean).map(String),
  );
  const claimed = new Set((state.claimed || []).filter(Boolean).map(String));
  const existing = new Set<string>();
  for (const card of cards) {
    const key = sourceKey(card);
    if (key) existing.add(key);
  }
  const added: string[] = [];
  for (const raw of state.suggested || []) {
    const line = JSON.parse(JSON.stringify(raw || {})) as Record<
      string,
      unknown
    >;
    const key = sourceKey(line);
    if (!key || existing.has(key) || dismissed.has(key) || claimed.has(key)) {
      continue;
    }
    line.source_key = key;
    if (line.included == null) line.included = true;
    line.auto = true;
    cards.push(line);
    existing.add(key);
    added.push(key);
  }
  return { cards, added, dismissed: [...dismissed] };
}

function assertNoSend(body: Record<string, unknown> | null | undefined): void {
  if (!body || typeof body !== "object") return;
  for (const key of BLOCKED_KEYS) {
    if (body[key]) {
      throw new RunningDraftError(AGENT_ONLY, 403, "agent_draft_only");
    }
  }
  if (body.status && body.status !== "draft") {
    throw new RunningDraftError(AGENT_ONLY, 403, "agent_draft_only");
  }
  const action = String(body.action || "");
  if (action && !DRAFT_ACTIONS.includes(action)) {
    throw new RunningDraftError(AGENT_ONLY, 403, "agent_draft_only");
  }
}

function roundMoney(value: unknown): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function uuidOrNull(value: unknown): string | null {
  const text = String(value || "");
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(text)
    ? text
    : null;
}

function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function assertMonday(iso: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new RunningDraftError(
      "week_start must be a Monday.",
      422,
      "week_start",
    );
  }
  const [year, month, day] = iso.split("-").map(Number);
  if (new Date(Date.UTC(year, month - 1, day)).getUTCDay() !== 1) {
    throw new RunningDraftError(
      "week_start must be a Monday.",
      422,
      "week_start",
    );
  }
}

function embeddedJob(row: Record<string, unknown>): Record<string, unknown> {
  const raw = row.jobs;
  if (Array.isArray(raw)) return (raw[0] || {}) as Record<string, unknown>;
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  return {};
}

function lookupFailed(error: { message?: string } | null, missing: RegExp) {
  const message = String(error?.message || "");
  const storage = missing.test(message);
  throw new RunningDraftError(
    storage
      ? "Running draft storage is not installed yet."
      : "Could not read the draft.",
    503,
    storage ? "running_draft_storage" : "running_draft_lookup",
  );
}

async function loadUser(client: any, userId: string) {
  if (!uuidOrNull(userId)) {
    throw new RunningDraftError(
      "That person was not found.",
      404,
      "running_draft_user",
    );
  }
  const { data, error } = await client.from("users")
    .select("id, org_id, role, trade_details, invoice_type")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    throw new RunningDraftError(
      "Could not read this person.",
      503,
      "running_draft_lookup",
    );
  }
  if (!data?.id || !data.org_id) {
    throw new RunningDraftError(
      "That person was not found.",
      404,
      "running_draft_user",
    );
  }
  return data;
}

function requireFlag(user: { trade_details?: unknown }) {
  if (!runningInvoiceDraftEnabled(user.trade_details)) {
    throw new RunningDraftError(
      "Saving is not switched on for this account yet.",
      403,
      "running_draft_off",
    );
  }
}

async function loadWeekDrafts(
  client: any,
  userId: string,
  orgId: string,
  weekStart: string,
) {
  const { data, error } = await client.from("trade_invoices")
    .select(
      "id, created_by_agent, draft_builder, draft_origin, agent_label, dismissed_source_keys, notes, gst_on, invoice_source, created_at",
    )
    .eq("user_id", userId)
    .eq("org_id", orgId)
    .eq("week_start", weekStart)
    .eq("status", "draft")
    .order("created_at", { ascending: true });
  if (error) lookupFailed(error, /draft_builder|column/i);
  const rows = data || [];
  if (rows.length > 1) {
    throw new RunningDraftError(
      "Multiple weekly drafts need office review.",
      409,
      "multiple_drafts",
    );
  }
  const row = rows[0] || null;
  if (row && row.invoice_source && row.invoice_source !== "hourly") {
    throw new RunningDraftError(
      "This week already has another draft. Open that one, or ask the office, before saving here.",
      409,
      "week_draft_occupied",
    );
  }
  return row;
}

async function loadClaimed(client: any, userId: string): Promise<string[]> {
  const keys = new Set<string>();
  const { data: invoices, error } = await client.from("trade_invoices")
    .select("id, work_order_id, status")
    .eq("user_id", userId)
    .not("status", "in", "(draft,failed,ops-reject)");
  if (error) {
    throw new RunningDraftError(
      "Could not read invoices already sent.",
      503,
      "running_draft_lookup",
    );
  }
  const ids: string[] = [];
  for (const row of invoices || []) {
    if (RELEASED.includes(String(row.status || ""))) continue;
    ids.push(row.id);
    if (row.work_order_id) keys.add("wo:" + row.work_order_id);
  }
  if (ids.length) {
    const { data: lines, error: lineError } = await client
      .from("trade_invoice_lines")
      .select("job_id, line_date, assignment_ids, source_work_order_id")
      .in("trade_invoice_id", ids);
    if (lineError) {
      throw new RunningDraftError(
        "Could not read invoices already sent.",
        503,
        "running_draft_lookup",
      );
    }
    for (const line of lines || []) {
      if (line.source_work_order_id) {
        keys.add("wo:" + line.source_work_order_id);
      }
      const day = String(line.line_date || "").slice(0, 10);
      if (line.job_id && day) keys.add("job:" + line.job_id + ":" + day);
      const assignmentIds = Array.isArray(line.assignment_ids)
        ? line.assignment_ids
        : [];
      for (const id of assignmentIds) if (id) keys.add("as:" + id);
    }
    const { data: locked, error: lockError } = await client
      .from("job_assignments")
      .select("id, invoiced_in")
      .eq("user_id", userId)
      .in("invoiced_in", ids);
    if (lockError) {
      throw new RunningDraftError(
        "Could not read work already invoiced.",
        503,
        "running_draft_lookup",
      );
    }
    for (const row of locked || []) {
      if (row.id) keys.add("as:" + row.id);
    }
  }
  return [...keys];
}

function assignmentQuery(
  client: any,
  userId: string,
  weekStart: string,
  weekEnd: string,
  columns: string,
) {
  return client.from("job_assignments")
    .select(columns)
    .eq("user_id", userId)
    .gte("scheduled_date", weekStart)
    .lte("scheduled_date", weekEnd)
    .in("status", ASSIGNMENT_STATUSES)
    .limit(200);
}

async function loadAssignments(
  client: any,
  userId: string,
  weekStart: string,
  weekEnd: string,
) {
  const withGhost =
    "id, job_id, scheduled_date, status, is_ghost, jobs(id, job_number, client_name, site_suburb, type)";
  const withoutGhost =
    "id, job_id, scheduled_date, status, jobs(id, job_number, client_name, site_suburb, type)";
  let { data, error } = await assignmentQuery(
    client,
    userId,
    weekStart,
    weekEnd,
    withGhost,
  );
  if (error && /is_ghost/i.test(String(error.message || ""))) {
    const retry = await assignmentQuery(
      client,
      userId,
      weekStart,
      weekEnd,
      withoutGhost,
    );
    data = retry.data;
    error = retry.error;
  }
  if (error) {
    throw new RunningDraftError(
      "Could not read this week's jobs.",
      503,
      "running_draft_lookup",
    );
  }
  return data || [];
}

async function groupJobIds(
  client: any,
  jobIds: string[],
): Promise<Set<string>> {
  const held = new Set<string>();
  if (jobIds.length === 0) return held;
  const { data, error } = await client.from("group_work_orders")
    .select("job_id, status")
    .in("job_id", jobIds);
  if (error) {
    throw new RunningDraftError(
      "Could not read group work orders for these hours.",
      503,
      "group_work_order_unreadable",
    );
  }
  for (const row of data || []) {
    if (row.job_id && String(row.status || "") !== "void") {
      held.add(String(row.job_id));
    }
  }
  return held;
}

async function loadSuggested(
  client: any,
  user: { id: string; invoice_type?: string | null },
  weekStart: string,
  weekEnd: string,
): Promise<Array<Record<string, unknown>>> {
  const suggested: Array<Record<string, unknown>> = [];
  const assignments = await loadAssignments(
    client,
    user.id,
    weekStart,
    weekEnd,
  );
  const jobIds: string[] = [];
  for (const row of assignments) {
    const id = String(row?.job_id || "");
    if (id && !jobIds.includes(id)) jobIds.push(id);
  }
  const grouped = await groupJobIds(client, jobIds);
  for (const row of assignments) {
    if (row.is_ghost === true) continue;
    if (!row.scheduled_date) continue;
    const jobId = String(row.job_id || "");
    if (jobId && grouped.has(jobId)) continue;
    const job = embeddedJob(row);
    suggested.push({
      assignment_id: row.id,
      job_id: row.job_id || job.id || null,
      job_number: job.job_number || "",
      client_name: job.client_name || "",
      site_suburb: job.site_suburb || "",
      job_type: job.type || "",
      scheduled_date: String(row.scheduled_date).slice(0, 10),
      included: true,
      auto: true,
    });
  }

  const completedFrom = `${addDays(weekStart, -1)}T00:00:00.000Z`;
  const completedTo = `${addDays(weekEnd, 2)}T00:00:00.000Z`;
  const { data: orders, error: orderError } = await client.from("work_orders")
    .select(
      "id, job_id, status, kind, quote_builder_version_id, scheduled_date, completed_at, assigned_user_id, jobs(id, job_number, client_name, site_suburb, type, status)",
    )
    .eq("assigned_user_id", user.id)
    .in("status", [...WORK_ORDER_INVOICE_LIST_STATUSES])
    .or(
      `and(scheduled_date.gte.${weekStart},scheduled_date.lte.${weekEnd}),and(completed_at.gte.${completedFrom},completed_at.lt.${completedTo})`,
    )
    .limit(200);
  if (orderError) {
    throw new RunningDraftError(
      "Could not read this week's work orders.",
      503,
      "running_draft_lookup",
    );
  }
  const orderJobIds: string[] = [];
  for (const order of orders || []) {
    const id = String(order?.job_id || "");
    if (id && !orderJobIds.includes(id)) orderJobIds.push(id);
  }
  const groupedOrders = await groupJobIds(client, [
    ...new Set([...jobIds, ...orderJobIds]),
  ]);
  const retireCrew = await readFlag(client, RETIRE_CREW_WORK_ORDERS_FLAG);
  for (const order of orders || []) {
    if (String(order.kind || "") === "job") continue;
    const job = embeddedJob(order);
    const shaped = {
      ...order,
      jobs: job,
      assignee_invoice_type: user.invoice_type ?? null,
    };
    if (hideRetiredCrewWorkOrder(shaped, retireCrew)) continue;
    if (!workOrderIsInvoiceReady(shaped)) continue;
    const day = weeklyWorkOrderBusinessDate(shaped);
    if (!day || day < weekStart || day > weekEnd) continue;
    if (groupedOrders.has(String(order.job_id || job.id || ""))) continue;
    suggested.push({
      work_order_id: order.id,
      job_id: order.job_id || job.id || null,
      job_number: job.job_number || "",
      client_name: job.client_name || "",
      site_suburb: job.site_suburb || "",
      job_type: job.type || "",
      scheduled_date: day,
      included: true,
      auto: true,
    });
  }
  return suggested;
}

function linesFromCards(
  cards: Array<Record<string, unknown>>,
  blocked: Set<string>,
): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  for (const card of cards) {
    if (
      !card || card.included === false || card.wo_mode || card.commission_mode
    ) {
      continue;
    }
    const key = sourceKey(card);
    if (key && blocked.has(key)) continue;
    const hours = Number(card.hours);
    if (!(hours > 0)) continue;
    const quantity = roundMoney(hours);
    const unitRate = roundMoney(card.rate);
    const lineTotal = roundMoney(quantity * unitRate);
    const day = String(card.work_date || card.scheduled_date || "").slice(
      0,
      10,
    );
    const times = draftTradeInvoiceTimeEntry({
      work_date: day || null,
      start_time: card.start_time ?? null,
      finish_time: card.finish_time ?? null,
      break_minutes: card.break_minutes ?? null,
    });
    const assignmentId = uuidOrNull(card.assignment_id);
    const workOrderId = uuidOrNull(card.work_order_id);
    lines.push({
      job_id: uuidOrNull(card.job_id),
      job_number: card.job_number || null,
      client_name: card.client_name || null,
      description: card.description || null,
      line_type: "labour",
      quantity,
      unit: "h",
      unit_rate: unitRate,
      line_total_ex: lineTotal,
      total_hours: quantity,
      hourly_rate: unitRate,
      line_date: day || null,
      work_date: times.columns.work_date,
      start_time: times.columns.start_time,
      finish_time: times.columns.finish_time,
      break_minutes: times.columns.break_minutes,
      acknowledgment_status: "pending",
      ...(assignmentId ? { assignment_ids: [assignmentId] } : {}),
      ...(workOrderId ? { source_work_order_id: workOrderId } : {}),
    });
  }
  return lines;
}

function headerFor(
  user: { id: string; org_id: string },
  weekStart: string,
  weekEnd: string,
  notes: unknown,
  gstOn: boolean,
  lines: Array<Record<string, unknown>>,
) {
  const sum = roundMoney(
    lines.reduce((total, line) => total + Number(line.line_total_ex || 0), 0),
  );
  const hours = roundMoney(
    lines.reduce((total, line) => total + Number(line.total_hours || 0), 0),
  );
  const breaks = lines.reduce(
    (total, line) => total + (Number(line.break_minutes) || 0),
    0,
  );
  let money;
  try {
    money = calculateTradeInvoiceMoney({
      grossEarned: sum,
      gstOn,
      earningsDate: weekEnd,
    });
  } catch (error) {
    if (error instanceof TradeInvoiceMoneyError) {
      throw new RunningDraftError(error.message, 422, error.code);
    }
    throw error;
  }
  return {
    org_id: user.org_id,
    user_id: user.id,
    week_start: weekStart,
    week_end: weekEnd,
    status: "draft",
    invoice_source: "hourly",
    subtotal_ex: money.gross_earned,
    gross_earned: money.gross_earned,
    net_pay: money.net_pay,
    total_inc: money.total_inc,
    gst: money.gst_amount,
    gst_on: money.gst_on,
    super_rate: money.super_rate,
    super_amount: money.super_amount,
    total_hours: hours,
    total_breaks_minutes: breaks,
    notes: notes ? String(notes) : null,
    has_manual_overrides: false,
  };
}

function dismissedFrom(
  body: Record<string, any> | null,
  incoming: Record<string, any>,
  prior: { dismissed_source_keys?: string[] } | null,
): string[] {
  if (Array.isArray(incoming.dismissedKeys)) {
    return incoming.dismissedKeys.map(String);
  }
  if (Array.isArray(body?.dismissed_source_keys)) {
    return body.dismissed_source_keys.map(String);
  }
  return prior?.dismissed_source_keys || [];
}

export async function getRunningInvoiceDraft(
  client: any,
  userId: string,
  weekStartRaw: string | null,
) {
  const user = await loadUser(client, userId);
  requireFlag(user);
  const weekStart = String(weekStartRaw || "").slice(0, 10);
  assertMonday(weekStart);
  const weekEnd = addDays(weekStart, 6);
  const draft = await loadWeekDrafts(client, user.id, user.org_id, weekStart);
  const [suggested, claimed] = await Promise.all([
    loadSuggested(client, user, weekStart, weekEnd),
    loadClaimed(client, user.id),
  ]);
  const builder =
    draft?.draft_builder && typeof draft.draft_builder === "object"
      ? draft.draft_builder
      : null;
  return {
    ok: true,
    draft_id: draft?.id || null,
    status: "draft",
    created_by_agent: !!draft?.created_by_agent,
    draft_origin: draft?.draft_origin || null,
    agent_label: draft?.agent_label || null,
    xero: false,
    draft_builder: builder,
    suggested,
    claimed,
    dismissed_source_keys: draft?.dismissed_source_keys ||
      builder?.dismissedKeys ||
      [],
    pay_rules: "unchanged_until_submit",
  };
}

function saveFailure(error: { message?: string } | null): never {
  const message = String(error?.message || "no invoice id returned");
  if (/not installed|function .* does not exist|draft_builder/i.test(message)) {
    throw new RunningDraftError(
      "Running draft storage is not installed yet.",
      503,
      "running_draft_storage",
    );
  }
  if (/no longer replaceable/i.test(message)) {
    throw new RunningDraftError(
      "That draft was replaced. Open the week again.",
      409,
      "draft_replaced",
    );
  }
  if (/multiple weekly drafts/i.test(message)) {
    throw new RunningDraftError(
      "Multiple weekly drafts need office review.",
      409,
      "multiple_drafts",
    );
  }
  if (/xero identity|cannot create or submit a xero/i.test(message)) {
    throw new RunningDraftError(AGENT_ONLY, 403, "agent_draft_only");
  }
  if (/work_order_claim_blocked_by_group_share/i.test(message)) {
    throw new RunningDraftError(
      "This job is on a group work order. Save your share, not ordinary hours.",
      409,
      "group_job_uses_share",
    );
  }
  console.error("[ops-api] running draft save failed:", message);
  throw new RunningDraftError(
    "Could not save this draft.",
    500,
    "running_draft_save",
  );
}

export async function saveRunningInvoiceDraft(
  client: any,
  userId: string,
  body: Record<string, any> | null,
  mode: "staff" | "agent" | "auto",
) {
  assertNoSend(body || {});
  const user = await loadUser(client, userId);
  requireFlag(user);
  const weekStart = String(
    body?.week_start || body?.draft_builder?.weekStart || "",
  )
    .slice(0, 10);
  assertMonday(weekStart);
  const weekEnd = addDays(weekStart, 6);
  const prior = await loadWeekDrafts(client, user.id, user.org_id, weekStart);
  if (body?.draft_id && prior && String(body.draft_id) !== String(prior.id)) {
    throw new RunningDraftError(
      "That draft was replaced. Open the week again.",
      409,
      "draft_replaced",
    );
  }
  if (body?.draft_id && !prior) {
    throw new RunningDraftError(
      "That draft was replaced. Open the week again.",
      409,
      "draft_replaced",
    );
  }
  const incoming = body?.draft_builder && typeof body.draft_builder === "object"
    ? body.draft_builder
    : (prior?.draft_builder && typeof prior.draft_builder === "object"
      ? prior.draft_builder
      : {});
  const [suggested, claimed] = await Promise.all([
    loadSuggested(client, user, weekStart, weekEnd),
    loadClaimed(client, user.id),
  ]);
  const agentLines = mode === "agent" && Array.isArray(body?.lines)
    ? body.lines
    : [];
  const merged = mergeApproved({
    cards: Array.isArray(incoming.jobCards) ? incoming.jobCards : [],
    dismissed: dismissedFrom(body, incoming, prior),
    claimed,
    suggested: suggested.concat(agentLines),
  });
  const gstOn = body?.gst_on != null ? !!body.gst_on : !!incoming.gst_on;
  const notes = body?.notes != null ? body.notes : (incoming.notes || "");
  const builder = {
    version: 1,
    // Persist identity only; current own group prices/acceptance are re-read before use.
    ...(Array.isArray(incoming.groupIds) && incoming.groupIds.length ? { groupIds:
      [...new Set(incoming.groupIds.map(String).filter((id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)))].slice(0, 100) } : {}),
    jobCards: merged.cards,
    invRows: Array.isArray(incoming.invRows) ? incoming.invRows : [],
    invLumpLines: Array.isArray(incoming.invLumpLines)
      ? incoming.invLumpLines
      : [],
    dismissedKeys: merged.dismissed,
    notes,
    gst_on: gstOn,
    weekStart,
    weekEnd,
  };
  const blocked = new Set<string>([...claimed, ...merged.dismissed]);
  const lines = linesFromCards(merged.cards, blocked);
  const createdByAgent = mode === "agent" ? true : !!prior?.created_by_agent;
  const origin = mode === "agent"
    ? "agent"
    : (prior?.draft_origin || (mode === "auto" ? "auto" : "staff"));
  const agentLabel = mode === "agent"
    ? String(body?.agent_label || prior?.agent_label || "agent").slice(0, 80)
    : (prior?.agent_label || null);
  const payload = {
    p_invoice: headerFor(user, weekStart, weekEnd, notes, gstOn, lines),
    p_lines: lines,
    p_requested_prior_draft_id: prior?.id || null,
    p_builder: builder,
    p_origin: origin,
    p_agent_label: agentLabel,
    p_dismissed: merged.dismissed,
    p_created_by_agent: createdByAgent,
    p_pay_unconfirmed: true,
  };
  const { data, error } = await client.rpc(
    "persist_running_trade_invoice_draft_v1",
    payload,
  );
  if (error || !data) saveFailure(error);
  return {
    ok: true,
    draft_id: data,
    status: "draft",
    created_by_agent: createdByAgent,
    draft_origin: origin,
    agent_label: agentLabel,
    xero: false,
    submitted: false,
    draft_builder: builder,
    added: merged.added,
    pay_rules: "unchanged_until_submit",
  };
}
