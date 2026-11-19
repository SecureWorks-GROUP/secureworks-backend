// deno-lint-ignore-file no-explicit-any
// ════════════════════════════════════════════════════════════
// Who is behind on invoicing (G3).
//
//   pay_run_who_is_behind  GET  ?weeks=4 (1..8) &as_of=YYYY-MM-DD (Perth today)
//
// For the approver: each trade with booked days in the last N full weeks and,
// for each week, whether they have invoiced it (missing, draft, submitted,
// approved, paid or held with the office), plus the group work orders that
// are stuck on a crew member with no hours, or waiting on the crew past a day.
//
// Approvers only, the same check as the pay run (ruling 34.13): anyone not on
// trade_pay_settings.pay_run_approver_user_ids is refused 403
// pay_run_approver_only before anything else is read, the server key included.
// Read only: no write, no RPC, no Xero. It reads no rate and no amount, so it
// can show no one's pay. Any failed read is 503 pay_run_unreadable, never a
// shorter list. It does not read the G4 switch: the office-entry and dispute
// marks it shows are on the hours rows whether the switch is on or off.
// ════════════════════════════════════════════════════════════

import { addDays, perthDay, TradePayRunError } from "./trade_pay_run.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = 1000;
const ID_CHUNK = 25;
/** A booking longer than this is read as its first 31 days. */
const MAX_SPAN_DAYS = 31;
export const BEHIND_DEFAULT_WEEKS = 4;
export const BEHIND_MAX_WEEKS = 8;
/** A group waiting on the crew longer than this is stuck. */
export const STUCK_AFTER_HOURS = 24;

export type WeekInvoiceStatus =
  | "missing"
  | "draft"
  | "submitted"
  | "approved"
  | "paid"
  | "held";

/** Hold reasons that mean the line has no agreed price yet. */
export const UNPRICED_HOLD_REASONS = new Set([
  "no_work_order",
  "no_amount",
  "hourly_no_maximum",
]);

const unreadable = (what: string) =>
  new TradePayRunError(
    "pay_run_unreadable",
    `Who is behind could not be read (${what}). Nothing is shown rather than a shorter list.`,
    503,
  );

// ── Inputs ─────────────────────────────────────────────────

function isIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function isoDow(day: string): number {
  const d = new Date(`${day}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

export function behindWeeksParam(raw: unknown): number {
  if (raw == null || String(raw).trim() === "") return BEHIND_DEFAULT_WEEKS;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) {
    throw new TradePayRunError("pay_run_weeks_invalid", "weeks must be a number from 1 to 8", 400);
  }
  return Math.min(BEHIND_MAX_WEEKS, Math.max(1, Math.trunc(n)));
}

export function behindAsOfParam(raw: unknown, now: Date): string {
  if (raw == null || String(raw).trim() === "") return perthDay(now);
  const v = String(raw).trim();
  if (!isIsoDate(v)) {
    throw new TradePayRunError("pay_run_as_of_invalid", "as_of must be a date, YYYY-MM-DD", 400);
  }
  return v;
}

/**
 * The Mondays of the last `weeks` full weeks on or before as_of, oldest
 * first. On a Sunday the week still running is not over, as for the pay run.
 */
export function behindWeekStarts(asOf: string, weeks: number): string[] {
  const lastSunday = addDays(asOf, -isoDow(asOf));
  const lastMonday = addDays(lastSunday, -6);
  const out: string[] = [];
  for (let i = weeks - 1; i >= 0; i--) out.push(addDays(lastMonday, -7 * i));
  return out;
}

function weekOf(day: string, weekStarts: string[]): string | null {
  const monday = addDays(day, 1 - isoDow(day));
  return weekStarts.includes(monday) ? monday : null;
}

// ── Pure rules ─────────────────────────────────────────────

/** A booking that is real crew work: not a ghost watcher, observer or cancelled. */
export function realBooking(row: Record<string, any>): boolean {
  if (!row?.user_id || !row?.scheduled_date) return false;
  if (row.is_ghost === true) return false;
  if (String(row.role ?? "").toLowerCase() === "observer") return false;
  if (String(row.status ?? "").toLowerCase() === "cancelled") return false;
  return true;
}

/** Every day a booking covers, capped at MAX_SPAN_DAYS. */
export function bookingDays(row: Record<string, any>): string[] {
  const start = String(row.scheduled_date).slice(0, 10);
  const endRaw = row.scheduled_end ? String(row.scheduled_end).slice(0, 10) : start;
  const end = isIsoDate(endRaw) && endRaw >= start ? endRaw : start;
  const days: string[] = [];
  for (let d = start; d <= end && days.length < MAX_SPAN_DAYS; d = addDays(d, 1)) days.push(d);
  return days;
}

const STATUS_RANK: Record<string, number> = {
  draft: 1,
  pending_acknowledgment: 2,
  queried: 2,
  acknowledged: 2,
  pending_ops_review: 2,
  approved: 3,
  pushed_to_xero: 3,
  paid: 4,
};
const RANK_STATUS: WeekInvoiceStatus[] = ["missing", "draft", "submitted", "approved", "paid"];

/** A held line still with the office. */
export function lineHeldOpen(line: Record<string, any>): boolean {
  const review = String(line?.office_review_status ?? "");
  return line?.hold_reason != null && (review === "awaiting" || review === "queried");
}

/**
 * One week's answer from that week's invoices and their lines. A rejected
 * invoice (ops-reject) counts as nothing sent. The best progress wins
 * (paid > approved or pushed > submitted > draft); a line still with the
 * office makes the week `held` unless it is already paid.
 */
export function weekInvoiceSummary(
  invoices: Array<Record<string, any>>,
  linesByInvoice: Map<string, Array<Record<string, any>>>,
): {
  invoice_status: WeekInvoiceStatus;
  draft_lines_count: number;
  held_lines_count: number;
  unpriced_wo_lines_count: number;
} {
  let rank = 0;
  let draftLines = 0;
  let heldLines = 0;
  let unpriced = 0;
  let heldInvoice = false;
  for (const inv of invoices) {
    const status = String(inv.status ?? "");
    if (status === "ops-reject") continue;
    const lines = linesByInvoice.get(String(inv.id)) ?? [];
    if (status === "draft") {
      draftLines += lines.length;
      rank = Math.max(rank, 1);
      continue;
    }
    if (inv.invoice_kind === "held") heldInvoice = true;
    else rank = Math.max(rank, STATUS_RANK[status] ?? 0);
    for (const line of lines) {
      if (!lineHeldOpen(line)) continue;
      heldLines += 1;
      if (UNPRICED_HOLD_REASONS.has(String(line.hold_reason))) unpriced += 1;
    }
  }
  let status = RANK_STATUS[rank];
  if (status !== "paid" && (heldLines > 0 || (heldInvoice && rank < 2))) status = "held";
  return {
    invoice_status: status,
    draft_lines_count: draftLines,
    held_lines_count: heldLines,
    unpriced_wo_lines_count: unpriced,
  };
}

/** Where a group is stuck, or null when it is not stuck. */
export function groupStuckStep(input: {
  claimState: string | null;
  crewTotal: number;
  crewWithHours: number;
  openDispute: boolean;
  waitingHours: number;
}): string | null {
  if (input.openDispute || input.claimState === "disputed") return "disputed";
  if (input.crewTotal > 0 && input.crewWithHours === 0) return "needs_hours";
  if (input.crewWithHours < input.crewTotal) return "awaiting_others";
  if (input.waitingHours < STUCK_AFTER_HOURS) return null;
  if (input.claimState === "waiting_approval") return "awaiting_crew_approval";
  if (input.claimState === "waiting_hours") return "awaiting_others";
  return null;
}

// ── Reads ──────────────────────────────────────────────────

export type PayBehindReads = {
  approvers(): Promise<string[]>;
  bookings(from: string, to: string): Promise<Array<Record<string, any>>>;
  users(ids: string[]): Promise<Array<{ id: string; name: string | null; org_id: string | null }>>;
  invoices(orgId: string, userIds: string[], from: string, to: string): Promise<Array<Record<string, any>>>;
  lines(invoiceIds: string[]): Promise<Array<Record<string, any>>>;
  openGroups(orgId: string): Promise<Array<Record<string, any>>>;
  participants(groupIds: string[]): Promise<Array<{ group_id: string; user_id: string }>>;
  entries(groupIds: string[]): Promise<Array<Record<string, any>>>;
  jobs(jobIds: string[]): Promise<Array<{ id: string; job_number: string | null; site_suburb: string | null }>>;
};

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function allPages(
  page: (from: number, to: number) => PromiseLike<{ data: any; error: any }>,
  what: string,
): Promise<any[]> {
  const rows: any[] = [];
  for (let from = 0;; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error || !Array.isArray(data)) throw unreadable(what);
    rows.push(...data);
    if (data.length < PAGE) return rows;
  }
}

async function chunkedPages(
  ids: string[],
  page: (chunk: string[], from: number, to: number) => PromiseLike<{ data: any; error: any }>,
  what: string,
): Promise<any[]> {
  const rows: any[] = [];
  for (const chunk of chunks([...new Set(ids)], ID_CHUNK)) {
    rows.push(...await allPages((from, to) => page(chunk, from, to), what));
  }
  return rows;
}

/** The real reads, through the service client. Selects only; no rate or amount column. */
export function payBehindReadsFromClient(client: any): PayBehindReads {
  return {
    async approvers() {
      const { data, error } = await client.from("trade_pay_settings")
        .select("pay_run_approver_user_ids").eq("id", 1).maybeSingle();
      if (error || !data || !Array.isArray(data.pay_run_approver_user_ids)) {
        throw unreadable("the approver list");
      }
      return data.pay_run_approver_user_ids.map(String);
    },
    async bookings(from, to) {
      return await allPages(
        (a, b) =>
          client.from("job_assignments")
            .select("id, user_id, scheduled_date, scheduled_end, status, role, is_ghost")
            .not("user_id", "is", null)
            .lte("scheduled_date", to)
            .or(`scheduled_date.gte.${from},scheduled_end.gte.${from}`)
            .order("id").range(a, b),
        "the bookings",
      );
    },
    async users(ids) {
      return await chunkedPages(
        ids,
        (chunk, a, b) => client.from("users").select("id, name, org_id").in("id", chunk).order("id").range(a, b),
        "the people",
      );
    },
    async invoices(orgId, userIds, from, to) {
      return await chunkedPages(
        userIds,
        (chunk, a, b) =>
          client.from("trade_invoices")
            .select("id, user_id, week_start, status, invoice_kind")
            .eq("org_id", orgId)
            .in("user_id", chunk)
            .or(`and(week_start.gte.${from},week_start.lte.${to}),and(week_start.is.null,created_at.gte.${from}T00:00:00+08:00)`)
            .order("id").range(a, b),
        "the invoices",
      );
    },
    async lines(invoiceIds) {
      return await chunkedPages(
        invoiceIds,
        (chunk, a, b) =>
          client.from("trade_invoice_lines")
            .select("id, trade_invoice_id, work_date, hold_reason, office_review_status")
            .in("trade_invoice_id", chunk)
            .order("id").range(a, b),
        "the invoice lines",
      );
    },
    async openGroups(orgId) {
      // A void group, a frozen split and an invoiced claim are not waiting on anyone.
      return await allPages(
        (a, b) =>
          client.from("group_work_orders")
            .select("id, job_id, status, claim_state, claim_deadline_at, created_at, hours_changed_at, split_frozen_at")
            .eq("org_id", orgId)
            .neq("status", "void")
            .is("split_frozen_at", null)
            .or("claim_state.is.null,claim_state.neq.invoiced")
            .order("id").range(a, b),
        "the group work orders",
      );
    },
    async participants(groupIds) {
      return await chunkedPages(
        groupIds,
        (chunk, a, b) =>
          client.from("group_work_order_participants").select("group_id, user_id").in("group_id", chunk)
            .order("id").range(a, b),
        "the group crews",
      );
    },
    async entries(groupIds) {
      return await chunkedPages(
        groupIds,
        (chunk, a, b) =>
          client.from("group_work_order_time_entries")
            .select("id, group_id, user_id, hours, entered_by_office, disputed_at, dispute_resolved_at")
            .in("group_id", chunk)
            .order("id").range(a, b),
        "the group hours",
      );
    },
    async jobs(jobIds) {
      return await chunkedPages(
        jobIds,
        (chunk, a, b) => client.from("jobs").select("id, job_number, site_suburb").in("id", chunk).order("id").range(a, b),
        "the jobs",
      );
    },
  };
}

// ── The read ───────────────────────────────────────────────

function hoursBetween(fromIso: string | null | undefined, now: Date): number {
  const at = Date.parse(String(fromIso ?? ""));
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, (now.getTime() - at) / 3_600_000);
}

export async function readWhoIsBehind(
  reads: PayBehindReads,
  opts: {
    orgId: string | null | undefined;
    actorUserId?: string | null;
    weeks?: unknown;
    asOf?: unknown;
    now?: Date;
  },
): Promise<Record<string, unknown>> {
  const orgId = String(opts.orgId ?? "").trim();
  if (!UUID_RE.test(orgId)) {
    throw new TradePayRunError(
      "pay_run_no_org",
      "Your profile has no organisation, so who is behind cannot be read",
      403,
    );
  }
  // Ruling 34.13: approvers only, checked before anything else is read.
  const approvers = await reads.approvers();
  const actor = String(opts.actorUserId ?? "").trim();
  if (actor === "" || !approvers.includes(actor)) {
    throw new TradePayRunError(
      "pay_run_approver_only",
      "Only a pay run approver can see who is behind on invoicing.",
      403,
    );
  }
  const now = opts.now ?? new Date();
  const weeks = behindWeeksParam(opts.weeks);
  const asOf = behindAsOfParam(opts.asOf, now);
  const weekStarts = behindWeekStarts(asOf, weeks);
  const from = weekStarts[0];
  const to = addDays(weekStarts[weekStarts.length - 1], 6);

  // Booked days per person and week.
  const daysByUserWeek = new Map<string, Map<string, Set<string>>>();
  for (const row of await reads.bookings(from, to)) {
    if (!realBooking(row)) continue;
    for (const day of bookingDays(row)) {
      if (day < from || day > to) continue;
      const week = weekOf(day, weekStarts);
      if (!week) continue;
      const userId = String(row.user_id);
      const byWeek = daysByUserWeek.get(userId) ?? new Map<string, Set<string>>();
      const days = byWeek.get(week) ?? new Set<string>();
      days.add(day);
      byWeek.set(week, days);
      daysByUserWeek.set(userId, byWeek);
    }
  }

  // Only people in the caller's company.
  const people = new Map<string, string>();
  for (const u of await reads.users([...daysByUserWeek.keys()])) {
    if (String(u.org_id ?? "") === orgId) people.set(String(u.id), String(u.name ?? "").trim() || "Unnamed");
  }
  const userIds = [...people.keys()];

  const invoices = userIds.length ? await reads.invoices(orgId, userIds, from, to) : [];
  const lines = invoices.length ? await reads.lines(invoices.map((i) => String(i.id))) : [];
  const linesByInvoice = new Map<string, Array<Record<string, any>>>();
  for (const line of lines) {
    const id = String(line.trade_invoice_id);
    linesByInvoice.set(id, [...(linesByInvoice.get(id) ?? []), line]);
  }
  // An invoice belongs to its week_start; one without a week to the weeks its lines were worked.
  const invoicesByUserWeek = new Map<string, Array<Record<string, any>>>();
  for (const inv of invoices) {
    if (String(inv.user_id ?? "") === "" || !people.has(String(inv.user_id))) continue;
    const weeksOf = new Set<string>();
    if (inv.week_start) {
      const w = weekOf(String(inv.week_start).slice(0, 10), weekStarts);
      if (w) weeksOf.add(w);
    } else {
      for (const line of linesByInvoice.get(String(inv.id)) ?? []) {
        const w = line.work_date ? weekOf(String(line.work_date).slice(0, 10), weekStarts) : null;
        if (w) weeksOf.add(w);
      }
    }
    for (const w of weeksOf) {
      const key = `${inv.user_id}|${w}`;
      invoicesByUserWeek.set(key, [...(invoicesByUserWeek.get(key) ?? []), inv]);
    }
  }

  const behindTrades: Array<Record<string, unknown>> = [];
  for (const userId of userIds) {
    const byWeek = daysByUserWeek.get(userId) ?? new Map();
    const weekRows: Array<Record<string, unknown>> = [];
    for (const week of weekStarts) {
      const scheduledDays = byWeek.get(week)?.size ?? 0;
      const summary = weekInvoiceSummary(invoicesByUserWeek.get(`${userId}|${week}`) ?? [], linesByInvoice);
      if (scheduledDays === 0 && summary.held_lines_count === 0 && summary.draft_lines_count === 0) continue;
      weekRows.push({ week_start: week, scheduled_days: scheduledDays, ...summary });
    }
    const missing = weekRows.filter((w) => w.invoice_status === "missing" && Number(w.scheduled_days) > 0).length;
    const drafts = weekRows.filter((w) => w.invoice_status === "draft").length;
    const held = weekRows.filter((w) => w.invoice_status === "held").length;
    if (missing + drafts + held === 0) continue;
    behindTrades.push({
      user_id: userId,
      display_name: people.get(userId),
      weeks: weekRows,
      missing_weeks_count: missing,
      unsent_draft_count: drafts,
      held_count: held,
    });
  }
  behindTrades.sort((a, b) =>
    Number(b.missing_weeks_count) - Number(a.missing_weeks_count) ||
    String(a.display_name).localeCompare(String(b.display_name)) ||
    String(a.user_id).localeCompare(String(b.user_id))
  );

  const stuckGroups = await readStuckGroups(reads, orgId, now);

  return {
    ok: true,
    as_of: asOf,
    weeks: weekStarts,
    trades_with_bookings: userIds.length,
    behind_trades: behindTrades,
    stuck_groups: stuckGroups,
  };
}

async function readStuckGroups(
  reads: PayBehindReads,
  orgId: string,
  now: Date,
): Promise<Array<Record<string, unknown>>> {
  const groups = await reads.openGroups(orgId);
  if (groups.length === 0) return [];
  const groupIds = groups.map((g) => String(g.id));
  const [participants, entries] = await Promise.all([
    reads.participants(groupIds),
    reads.entries(groupIds),
  ]);
  const crewIds = [...new Set(participants.map((p) => String(p.user_id)))];
  const [users, jobs] = await Promise.all([
    crewIds.length ? reads.users(crewIds) : Promise.resolve([]),
    reads.jobs([...new Set(groups.map((g) => String(g.job_id)))]),
  ]);
  const names = new Map(users.map((u) => [String(u.id), String(u.name ?? "").trim() || "Unnamed"]));
  const jobById = new Map(jobs.map((j) => [String(j.id), j]));

  const out: Array<Record<string, unknown>> = [];
  for (const g of groups) {
    const gid = String(g.id);
    const crew = participants.filter((p) => String(p.group_id) === gid).map((p) => String(p.user_id));
    if (crew.length === 0) continue;
    const mine = entries.filter((e) => String(e.group_id) === gid);
    const crewRows = crew.map((userId) => {
      const own = mine.filter((e) => String(e.user_id) === userId);
      const hours = own.reduce((sum, e) => sum + (Number(e.hours) > 0 ? Number(e.hours) : 0), 0);
      return {
        user_id: userId,
        display_name: names.get(userId) ?? "Unnamed",
        hours_entered: Math.round(hours * 100) / 100,
        office_entered: own.some((e) => e.entered_by_office === true),
        disputed: own.some((e) => e.disputed_at != null && e.dispute_resolved_at == null),
      };
    });
    const withHours = crewRows.filter((r) => r.hours_entered > 0).length;
    const openDispute = crewRows.some((r) => r.disputed);
    // Waiting since the last hours change, or since the group opened.
    const since = g.hours_changed_at ?? g.created_at ?? null;
    const waiting = hoursBetween(since, now);
    const step = groupStuckStep({
      claimState: g.claim_state ?? null,
      crewTotal: crew.length,
      crewWithHours: withHours,
      openDispute,
      waitingHours: waiting,
    });
    if (!step) continue;
    const job = jobById.get(String(g.job_id));
    out.push({
      group_id: gid,
      job_id: String(g.job_id),
      job_number: job?.job_number ?? null,
      site_suburb: job?.site_suburb ?? null,
      stuck_step: step,
      days_stuck: Math.floor(waiting / 24),
      crew_total_count: crew.length,
      crew_missing: crewRows.filter((r) => r.hours_entered <= 0 || r.disputed),
    });
  }
  out.sort((a, b) =>
    Number(b.days_stuck) - Number(a.days_stuck) || String(a.group_id).localeCompare(String(b.group_id))
  );
  return out;
}

/** For tests: the window the read covers. */
export function behindWindow(asOf: string, weeks: number): { from: string; to: string } {
  const starts = behindWeekStarts(asOf, weeks);
  return { from: starts[0], to: addDays(starts[starts.length - 1], 6) };
}
