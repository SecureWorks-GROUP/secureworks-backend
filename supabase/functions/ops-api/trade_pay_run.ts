// deno-lint-ignore-file no-explicit-any
// ════════════════════════════════════════════════════════════
// The weekly pay run: the staff read (P1-10.2).
//
//   pay_run  GET  ?week_start=YYYY-MM-DD (a Monday; default the last full
//                 week, Perth)
//
// One read gives the approver the week's invoices, each clean or stopped with
// plain reasons, the totals of the clean ones, the super owed per person and a
// hash of exactly what was shown, so P1-10.3 can approve only a week that
// still reads the same. The checks are the database's: pay-run check v2
// (trade_pay_run_check_v2, 20261118043357) and the standing checks
// (trade_pay_run_standing_checks, P1-08.3). This file chooses the week's
// invoices, joins the two answers and adds up the money. It never writes and
// never calls Xero.
//
// Approvers only (ruling 34.13: only the approver list sees named pay). The
// front door admits the staff operator set or the server key (the action is in
// no trade, routine or agent-read list); this read then refuses 403
// pay_run_approver_only to anyone not on the approver list, the server key
// included, before any pay is read.
// Any read that fails is 503 pay_run_unreadable, never a smaller or empty week.
// ════════════════════════════════════════════════════════════

import { buildPayView } from "./trade_pay_view.ts";
import {
  reimbursementLinesTotalEx,
  TRADE_INVOICE_EMPLOYER_SUPER_BASIS,
  validatePersistedTradeInvoiceMoney,
} from "./trade_invoice_money.ts";

export class TradePayRunError extends Error {
  status: number;
  code: string;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;
const PERTH_OFFSET_MS = 8 * 3_600_000; // Perth keeps +08:00 all year.
export const PAY_RUN_CHECK_WEEKS = 8;

const unreadable = (what: string) =>
  new TradePayRunError(
    "pay_run_unreadable",
    `The pay run could not be read (${what}). Nothing is shown rather than a smaller week.`,
    503,
  );

// ── Dates ──────────────────────────────────────────────────

function isIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS)
    .toISOString().slice(0, 10);
}

/** The Perth calendar day of an instant. */
export function perthDay(instant: Date | string): string {
  const t = typeof instant === "string"
    ? Date.parse(instant)
    : instant.getTime();
  return new Date(t + PERTH_OFFSET_MS).toISOString().slice(0, 10);
}

/** ISO weekday, Monday 1 to Sunday 7. */
function isoDow(day: string): number {
  const d = new Date(`${day}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** The Monday of the Perth week holding an instant. */
export function perthMonday(instant: Date | string): string {
  const day = perthDay(instant);
  return addDays(day, 1 - isoDow(day));
}

/**
 * The Monday of the most recent week that ended on or before last Sunday,
 * Perth time. On a Sunday the week still running is not over, so last Sunday
 * is the one before.
 */
export function defaultPayRunWeek(now: Date): string {
  const today = perthDay(now);
  const lastSunday = addDays(today, -isoDow(today));
  return addDays(lastSunday, -6);
}

export function payRunWeek(
  weekStart: string | null | undefined,
  now: Date,
): string {
  if (weekStart == null || String(weekStart).trim() === "") {
    return defaultPayRunWeek(now);
  }
  const v = String(weekStart).trim();
  if (!isIsoDate(v) || isoDow(v) !== 1) {
    throw new TradePayRunError(
      "pay_run_week_invalid",
      "week_start must be a Monday, YYYY-MM-DD",
      400,
    );
  }
  return v;
}

/** Sunday 23:59:59 Perth time, six days after the Monday. */
export function payRunCutOff(week: string): string {
  return `${addDays(week, 6)}T23:59:59+08:00`;
}

// ── Which invoices are in the run ──────────────────────────

export type PayRunInvoiceRow = Record<string, any> & {
  id: string;
  invoice_number?: string | null;
  user_id?: string | null;
  week_start?: string | null;
  status?: string | null;
  invoice_kind?: string | null;
  submitted_at?: string | null;
  created_at?: string | null;
  pay_run_id?: string | null;
  xero_bill_id?: string | null;
};

/** The day an invoice was sent, Perth; created_at for an older row with none. */
function sentAt(row: PayRunInvoiceRow): string | null {
  return row.submitted_at ?? row.created_at ?? null;
}

/**
 * The pay week an invoice belongs to: its week_start, or for an invoice with
 * none the Monday of the Perth week it was sent (trade_invoices has no
 * invoice_date; pay-run check v2 uses the same rule).
 */
export function invoicePayWeek(row: PayRunInvoiceRow): string | null {
  if (row.week_start) return String(row.week_start).slice(0, 10);
  const sent = sentAt(row);
  return sent ? perthMonday(sent) : null;
}

// The one open director decision, one line. Change the value, nothing else.
// (run-invoice-unique was ruled 18 Nov 06:55, ruling A: a stopped invoice is
// listed again next week; a clean one is paid by one run only, which
// pay_run_id and P1-10.1's clean-once index hold.)
export type PayRunReach = {
  /**
   * pay-run-history. true: an invoice already billed in Xero the one-off way
   * is not run material (pay_run_id is new and null on every older invoice,
   * so without this the first run lists the whole history). false: the
   * ticket as written.
   */
  skipBilledInXero: boolean;
};
export const PAY_RUN_REACH: PayRunReach = {
  skipBilledInXero: true, // pay-run-history: default until the director rules
};

/**
 * Could this invoice be in a pay run at all? Standard or follow-on (a holding
 * invoice never is), not draft or sent back, not already paid by a run
 * (an invoice stopped in an earlier run is shown again), then the open
 * decision above. Change the run's reach here and nowhere else.
 */
export function payRunEligible(
  row: PayRunInvoiceRow,
  reach: PayRunReach = PAY_RUN_REACH,
): boolean {
  const kind = row.invoice_kind ?? "standard";
  return (kind === "standard" || kind === "follow_on") &&
    row.status !== "draft" && row.status !== "ops-reject" &&
    !row.pay_run_id &&
    !(reach.skipBilledInXero && row.xero_bill_id);
}

export type PayRunPlacement = "in_run" | "late" | "not_yet";

/**
 * Where an eligible invoice sits for week W. In the run: sent by the cut-off
 * and for week W or earlier, so an invoice sent late for an earlier week joins
 * the next run. Late: for week W but sent after the cut-off (shown, not paid
 * in this run). Anything else waits for a later week.
 */
export function payRunPlacement(
  row: PayRunInvoiceRow,
  week: string,
): PayRunPlacement {
  const payWeek = invoicePayWeek(row);
  const sent = sentAt(row);
  if (!payWeek || !sent || payWeek > week) return "not_yet";
  const onTime = Date.parse(sent) <= Date.parse(payRunCutOff(week));
  if (onTime) return "in_run";
  return payWeek === week ? "late" : "not_yet";
}

// ── Money ──────────────────────────────────────────────────

const cents = (v: number) => Math.round(v * 100);
const fromCents = (c: number) => c / 100;

export type PayRunMoney = {
  total_inc_super: number;
  paid_to_you: number;
  super_amount: number;
  reimbursements: number;
  gst: number;
  into_bank: number;
};

/**
 * One invoice's figures, from the stored split only. A super-inclusive
 * invoice reads through buildPayView (the trade's own screen). Any other
 * basis: super as stored, paid to you = net pay less reimbursements, total
 * including super = paid to you + super, into the bank = the cash payable.
 */
export function payRunInvoiceMoney(
  row: Record<string, any>,
  lines: ReadonlyArray<{ line_type?: unknown; line_total_ex?: unknown }>,
): PayRunMoney {
  const money = validatePersistedTradeInvoiceMoney(row);
  const reimbursements = reimbursementLinesTotalEx(lines);
  const view = buildPayView(money, {
    reimbursementsEx: reimbursements,
    taxSetAsidePercent: null,
    repayment: null,
  });
  if (view) {
    return {
      total_inc_super: view.total_inc_super,
      paid_to_you: view.paid_to_you,
      super_amount: view.paid_to_super,
      reimbursements,
      gst: view.gst,
      into_bank: view.into_bank,
    };
  }
  const paid = fromCents(cents(money.net_pay) - cents(reimbursements));
  return {
    total_inc_super: fromCents(cents(paid) + cents(money.super_amount)),
    paid_to_you: paid,
    super_amount: money.super_amount,
    reimbursements,
    gst: money.gst_amount,
    into_bank: money.trade_payable,
  };
}

/**
 * SHA-256 hex of the sorted clean invoice ids, each with its into-the-bank
 * amount in cents (`<id>:<cents>`), joined by commas.
 */
export async function cleanIdsHash(
  clean: ReadonlyArray<{ invoice_id: string; into_bank: number }>,
): Promise<string> {
  const text = [...clean]
    .sort((a, b) =>
      a.invoice_id < b.invoice_id ? -1 : a.invoice_id > b.invoice_id ? 1 : 0
    )
    .map((i) => `${i.invoice_id}:${cents(i.into_bank)}`)
    .join(",");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Reads ──────────────────────────────────────────────────

export type PayRunReads = {
  /** The run recorded for the week, or null. */
  run(orgId: string, week: string): Promise<Record<string, any> | null>;
  /** Invoice ids and push state recorded on a run. */
  runInvoices(
    runId: string,
  ): Promise<Array<{ invoice_id: string; pushed_at: string | null }>>;
  /** Every invoice of the org that could be in a run up to week W. */
  candidates(
    orgId: string,
    week: string,
    reach: PayRunReach,
  ): Promise<PayRunInvoiceRow[]>;
  invoicesById(ids: string[]): Promise<PayRunInvoiceRow[]>;
  lines(
    invoiceIds: string[],
  ): Promise<
    Array<
      { trade_invoice_id: string; line_type: unknown; line_total_ex: unknown }
    >
  >;
  /** Lines still with the office on holding invoices, with their invoice. */
  heldLines(
    orgId: string,
    week: string,
  ): Promise<Array<{ hold_reason: string | null; line_total_ex: unknown }>>;
  approvers(): Promise<string[]>;
  checkV2(
    params: {
      p_as_of: string;
      p_weeks: number;
      p_org_id: string;
      p_stage: string;
    },
  ): Promise<any>;
  standing(
    params: { p_org_id: string; p_invoice_ids: string[]; p_stage: string },
  ): Promise<any>;
};

const RUN_INVOICE_COLUMNS =
  "id, org_id, invoice_number, user_id, week_start, week_end, status, invoice_kind, submitted_at, created_at, pay_run_id, xero_bill_id, subtotal_ex, gst, gst_on, super_rate, super_amount, gross_earned, net_pay, super_basis, super_base_ex, total_inc, recurring_deduction_id, recurring_deduction_label, recurring_deduction_amount, recurring_deduction_note";
const PAGE = 1000;
const ID_CHUNK = 25;

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function allPages(
  page: (from: number, to: number) => Promise<{ data: any; error: any }>,
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

async function byIdChunks(
  ids: string[],
  read: (chunk: string[]) => Promise<{ data: any; error: any }>,
  what: string,
): Promise<any[]> {
  const rows: any[] = [];
  for (const chunk of chunks(ids, ID_CHUNK)) {
    const { data, error } = await read(chunk);
    if (error || !Array.isArray(data)) throw unreadable(what);
    rows.push(...data);
  }
  return rows;
}

/** The real reads, through the service client. Each failed read throws 503. */
export function payRunReadsFromClient(client: any): PayRunReads {
  return {
    async run(orgId, week) {
      // trade_pay_runs (org_id, week_start) unique index.
      const { data, error } = await client.from("trade_pay_runs")
        .select(
          "id, org_id, week_start, check_rule, approved_by, approved_at, standing, invoice_count, total_pays, super_total, status",
        )
        .eq("org_id", orgId).eq("week_start", week).maybeSingle();
      if (error) throw unreadable("the run record");
      return data ?? null;
    },
    async runInvoices(runId) {
      return await allPages(
        (from, to) =>
          client.from("trade_pay_run_invoices").select("invoice_id, pushed_at")
            .eq("run_id", runId).order("invoice_id").range(from, to),
        "the run's invoices",
      );
    },
    async candidates(orgId, week, reach) {
      return await allPages(
        (from, to) => {
          let q = client.from("trade_invoices").select(RUN_INVOICE_COLUMNS)
            .eq("org_id", orgId)
            .in("invoice_kind", ["standard", "follow_on"])
            .not("status", "in", "(draft,ops-reject)")
            .is("pay_run_id", null);
          if (reach.skipBilledInXero) q = q.is("xero_bill_id", null);
          return q.or(`week_start.lte.${week},week_start.is.null`)
            .order("id").range(from, to);
        },
        "the week's invoices",
      );
    },
    async invoicesById(ids) {
      return await byIdChunks(
        ids,
        (chunk) =>
          client.from("trade_invoices").select(RUN_INVOICE_COLUMNS).in(
            "id",
            chunk,
          ),
        "the run's invoices",
      );
    },
    async lines(invoiceIds) {
      const rows: any[] = [];
      for (const chunk of chunks(invoiceIds, ID_CHUNK)) {
        rows.push(
          ...await allPages(
            (from, to) =>
              client.from("trade_invoice_lines").select(
                "id, trade_invoice_id, line_type, line_total_ex",
              )
                .in("trade_invoice_id", chunk).order("id").range(from, to),
            "the invoice lines",
          ),
        );
      }
      return rows;
    },
    async heldLines(orgId, week) {
      // trade_invoice_lines_held_idx covers exactly these lines.
      const held = await allPages(
        (from, to) =>
          client.from("trade_invoice_lines").select(
            "id, trade_invoice_id, hold_reason, line_total_ex",
          )
            .not("hold_reason", "is", null)
            .in("office_review_status", ["awaiting", "queried"])
            .order("id").range(from, to),
        "the held lines",
      );
      const ids = [
        ...new Set(held.map((l: any) => String(l.trade_invoice_id))),
      ];
      const invoices = await byIdChunks(
        ids,
        (chunk) =>
          client.from("trade_invoices").select(
            "id, org_id, invoice_kind, status, week_start, submitted_at, created_at",
          )
            .in("id", chunk),
        "the held invoices",
      );
      const keep = new Set(
        invoices.filter((i: any) =>
          i.org_id === orgId && i.invoice_kind === "held" &&
          i.status !== "draft" && i.status !== "ops-reject" &&
          (invoicePayWeek(i) ?? "9999-12-31") <= week
        ).map((i: any) => String(i.id)),
      );
      return held.filter((l: any) => keep.has(String(l.trade_invoice_id)));
    },
    async approvers() {
      const { data, error } = await client.from("trade_pay_settings")
        .select("pay_run_approver_user_ids").eq("id", 1).maybeSingle();
      if (error || !data || !Array.isArray(data.pay_run_approver_user_ids)) {
        throw unreadable("the approver list");
      }
      return data.pay_run_approver_user_ids.map(String);
    },
    async checkV2(params) {
      const { data, error } = await client.rpc(
        "trade_pay_run_check_v2",
        params,
      );
      if (error) throw unreadable("pay-run check v2");
      return data;
    },
    async standing(params) {
      const { data, error } = await client.rpc(
        "trade_pay_run_standing_checks",
        params,
      );
      if (error) throw unreadable("the standing checks");
      return data;
    },
  };
}

// ── The read ───────────────────────────────────────────────

type Stop = { code: string; words: string };

function stopsOf(list: unknown): Stop[] | null {
  if (!Array.isArray(list)) return null;
  const out: Stop[] = [];
  for (const s of list) {
    const code = typeof s?.code === "string" ? s.code : null;
    const words = typeof s?.words === "string" ? s.words : null;
    if (!code || !words) return null;
    out.push({ code, words });
  }
  return out;
}

/**
 * The note check v2 gives an hourly line on a job whose work order has no
 * agreed amount (director ruling 15:54: a note, shown and counted, never a
 * stop). The director turns it into a stop later in the check itself.
 */
export const HOURLY_NO_AGREED_AMOUNT_NOTE = "hourly_no_agreed_amount";

type V2Entry = { verdict: string; stops: Stop[]; notes: Stop[]; trade_name: string };

function validV2(
  data: any,
  stage: string,
): Map<string, V2Entry> {
  if (
    !data || typeof data !== "object" || data.rule !== "trade-pay-check-v2" ||
    data.stage !== stage || !Array.isArray(data.invoices)
  ) throw unreadable("pay-run check v2");
  const out = new Map<string, V2Entry>();
  for (const inv of data.invoices) {
    const stops = stopsOf(inv?.stops);
    // Every v2 answer carries its notes (an empty list when none); missing
    // notes are an answer this read cannot trust, never "no notes".
    const notes = stopsOf(inv?.notes);
    if (
      !inv || typeof inv.invoice_id !== "string" || !stops || !notes ||
      inv.verdict !== (stops.length > 0 ? "stopped" : "clean")
    ) throw unreadable("pay-run check v2");
    out.set(inv.invoice_id, {
      verdict: inv.verdict,
      stops,
      notes,
      trade_name: typeof inv.trade_name === "string"
        ? inv.trade_name
        : "A trade",
    });
  }
  return out;
}

/** The six results pay-run-standing-v1 always returns, each exactly once. */
export const STANDING_CHECK_CODES = [
  "pay_equals_job_cost",
  "nobody_above_work_order",
  "super_is_12_over_112",
  "no_paid_line_without_work_order",
  "nothing_lost",
  "crew_accepted",
] as const;

function validStanding(data: any, stage: string, cleanIds: Set<string>) {
  if (
    !data || typeof data !== "object" || data.rule !== "pay-run-standing-v1" ||
    data.stage !== stage || !Array.isArray(data.checks) ||
    !Array.isArray(data.stopped_invoices) ||
    typeof data.run_blocked !== "boolean"
  ) throw unreadable("the standing checks");
  const stopped = new Map<string, Stop[]>();
  for (const s of data.stopped_invoices) {
    const stops = stopsOf(s?.stops);
    if (
      !s || typeof s.invoice_id !== "string" || !stops || stops.length === 0 ||
      !cleanIds.has(s.invoice_id)
    ) {
      throw unreadable("the standing checks");
    }
    stopped.set(s.invoice_id, stops);
  }
  // Every one of the six results, once each, with a pass answer. Missing or
  // extra results are an answer this read cannot trust, never "no difference
  // found".
  const seen = new Set<string>();
  for (const c of data.checks) {
    if (
      !c || typeof c !== "object" || typeof c.code !== "string" ||
      !(STANDING_CHECK_CODES as readonly string[]).includes(c.code) ||
      seen.has(c.code) || typeof c.pass !== "boolean"
    ) throw unreadable("the standing checks");
    seen.add(c.code);
  }
  if (seen.size !== STANDING_CHECK_CODES.length) {
    throw unreadable("the standing checks");
  }
  return {
    checks: data.checks,
    stopped,
    run_blocked: data.run_blocked,
    run_blocked_words: typeof data.run_blocked_words === "string"
      ? data.run_blocked_words
      : null,
  };
}

const OLDER_THAN_WINDOW: Stop = {
  code: "older_than_run_window",
  words: "This invoice is for a week more than 8 weeks ago. Check it by hand.",
};
/**
 * The statuses the run's stamp takes (approve_trade_pay_run, newest
 * migration). Before a run exists the read stops every other status, so an
 * invoice the read shows as clean is one the stamp will take, and the press
 * is never refused for a status the read did not show. A test pins this list
 * to the migration's.
 */
export const PAY_RUN_STAMP_STATUSES: readonly string[] = [
  "pending_ops_review",
  "queried",
];
const NOT_WAITING_FOR_RUN: Stop = {
  code: "not_waiting_for_run",
  words: "This invoice is not waiting for the pay run yet (the trade or the office still has it). Check it by hand.",
};
// cl-1622-crew-in-run, ruling (1): an all-in crew bill (employer super) is
// released and pushed with its whole crew, never by the run.
const CREW_RELEASE_PATH: Stop = {
  code: "crew_release_path",
  words:
    "This is an all-in crew bill. It is paid when the whole crew is released, not in the pay run.",
};

const MONEY_UNREADABLE: Stop = {
  code: "money_unreadable",
  words: "This invoice's pay figures do not add up. Check it by hand.",
};

/** Invoices counted per note code, whatever their verdict, codes in name
 * order. A note never stops an invoice; this keeps each noted group a plain
 * number on the run. */
export function notedByCode(
  items: readonly { notes: readonly Stop[] }[],
): { code: string; invoices: number }[] {
  const by = new Map<string, number>();
  for (const item of items) {
    for (const code of new Set(item.notes.map((x) => x.code))) {
      by.set(code, (by.get(code) ?? 0) + 1);
    }
  }
  return [...by.entries()]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([code, invoices]) => ({ code, invoices }));
}

/** Stopped invoices counted per stop code, codes in name order. */
export function stoppedByCode(
  items: readonly { verdict: string; stops: readonly Stop[] }[],
): { code: string; invoices: number }[] {
  const by = new Map<string, number>();
  for (const item of items) {
    if (item.verdict !== "stopped") continue;
    for (const code of new Set(item.stops.map((x) => x.code))) {
      by.set(code, (by.get(code) ?? 0) + 1);
    }
  }
  return [...by.entries()]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([code, invoices]) => ({ code, invoices }));
}

export async function readPayRun(
  reads: PayRunReads,
  opts: {
    orgId: string | null | undefined;
    weekStart?: string | null;
    actorUserId?: string | null;
    now?: Date;
    /** Tests only: the live read always uses PAY_RUN_REACH. */
    reach?: PayRunReach;
  },
): Promise<Record<string, unknown>> {
  const orgId = String(opts.orgId ?? "").trim();
  if (!UUID_RE.test(orgId)) {
    throw new TradePayRunError(
      "pay_run_no_org",
      "Your profile has no organisation, so the pay run cannot be read",
      403,
    );
  }
  const week = payRunWeek(opts.weekStart, opts.now ?? new Date());

  // Ruling 34.13: named pay is for the approver list only. The signed-in
  // caller is checked before any pay is read; the server key is no person.
  const approvers = await reads.approvers();
  const actor = String(opts.actorUserId ?? "").trim();
  if (actor === "" || !approvers.includes(actor)) {
    throw new TradePayRunError(
      "pay_run_approver_only",
      "Only a pay run approver can read the pay run.",
      403,
    );
  }

  const asOf = addDays(week, 6);
  const fromWeek = addDays(week, -7 * (PAY_RUN_CHECK_WEEKS - 1));

  const run = await reads.run(orgId, week);
  const stage = run ? "after_xero" : "before_xero";

  // Every invoice that could be in a run up to this week: the late ones for
  // this week come from here even once the run is recorded.
  const reach = opts.reach ?? PAY_RUN_REACH;
  const candidates = (await reads.candidates(orgId, week, reach)).filter((
    r,
  ) => payRunEligible(r, reach));
  const late = candidates.filter((r) => payRunPlacement(r, week) === "late");

  // The run's invoices: once a run is recorded, exactly the ones it recorded;
  // before, every eligible invoice placed in this week.
  let rows: PayRunInvoiceRow[];
  const pushedAt = new Map<string, string | null>();
  if (run) {
    const recorded = await reads.runInvoices(String(run.id));
    for (const r of recorded) {
      pushedAt.set(String(r.invoice_id), r.pushed_at ?? null);
    }
    rows = await reads.invoicesById([...pushedAt.keys()]);
    if (rows.length !== pushedAt.size) throw unreadable("the run's invoices");
  } else {
    rows = candidates.filter((r) => payRunPlacement(r, week) === "in_run");
  }

  const ids = rows.map((r) => String(r.id));
  const v2 = validV2(
    await reads.checkV2({
      p_as_of: asOf,
      p_weeks: PAY_RUN_CHECK_WEEKS,
      p_org_id: orgId,
      p_stage: stage,
    }),
    stage,
  );
  const lineRows = ids.length ? await reads.lines(ids) : [];
  const linesBy = new Map<string, typeof lineRows>();
  for (const l of lineRows) {
    const k = String(l.trade_invoice_id);
    if (!linesBy.has(k)) linesBy.set(k, []);
    linesBy.get(k)!.push(l);
  }

  type Item = {
    invoice_id: string;
    invoice_number: string | null;
    kind: string;
    user_id: string | null;
    trade_name: string;
    week_start: string | null;
    money: PayRunMoney | null;
    verdict: "clean" | "stopped";
    stops: Stop[];
    notes: Stop[];
    xero_bill_id: string | null;
    pushed: boolean;
  };
  const items: Item[] = rows.map((row) => {
    const id = String(row.id);
    const payWeek = invoicePayWeek(row);
    const found = v2.get(id);
    let stops: Stop[];
    let notes: Stop[] = [];
    let tradeName = "A trade";
    if (found) {
      stops = [...found.stops];
      notes = [...found.notes];
      tradeName = found.trade_name;
    } else if (payWeek && payWeek < fromWeek) {
      stops = [OLDER_THAN_WINDOW];
    } else {
      // Inside the window and missing from the check: never shown as clean.
      throw unreadable("pay-run check v2 left out an invoice of this week");
    }
    if (!run && !PAY_RUN_STAMP_STATUSES.includes(String(row.status ?? ""))) {
      stops.push(NOT_WAITING_FOR_RUN);
    }
    // Option A: an invoice this run approved keeps its press status until the
    // run pushes it, so the check's "not approved yet" is not a stop for it.
    if (run && String(row.pay_run_id ?? "") === String(run.id)) {
      stops = stops.filter((s) => s.code !== "invoice_not_approved");
    }
    if (row.super_basis === TRADE_INVOICE_EMPLOYER_SUPER_BASIS) {
      stops.push(CREW_RELEASE_PATH);
    }
    let money: PayRunMoney | null = null;
    try {
      money = payRunInvoiceMoney(row, linesBy.get(id) ?? []);
    } catch {
      stops.push(MONEY_UNREADABLE);
    }
    return {
      invoice_id: id,
      invoice_number: row.invoice_number ?? null,
      kind: row.invoice_kind ?? "standard",
      user_id: row.user_id ?? null,
      trade_name: tradeName,
      week_start: payWeek,
      money,
      verdict: stops.length > 0 ? "stopped" : "clean",
      stops,
      notes,
      xero_bill_id: row.xero_bill_id ?? null,
      pushed: run ? pushedAt.get(id) != null : Boolean(row.xero_bill_id),
    };
  });

  // The standing checks run on the ids v2 left clean, at the same stage. An
  // invoice they stop leaves the run; the rest go on.
  const cleanIds = items.filter((i) => i.verdict === "clean").map((i) =>
    i.invoice_id
  ).sort();
  const standing = validStanding(
    await reads.standing({
      p_org_id: orgId,
      p_invoice_ids: cleanIds,
      p_stage: stage,
    }),
    stage,
    new Set(cleanIds),
  );
  for (const item of items) {
    const extra = standing.stopped.get(item.invoice_id);
    if (extra) {
      item.stops.push(...extra);
      item.verdict = "stopped";
    }
  }

  const clean = items.filter((i) => i.verdict === "clean");
  const sum = (pick: (m: PayRunMoney) => number) =>
    fromCents(clean.reduce((t, i) => t + cents(pick(i.money!)), 0));
  const superBy = new Map<
    string,
    { user_id: string | null; trade_name: string; c: number }
  >();
  for (const i of clean) {
    const key = i.user_id ?? `invoice:${i.invoice_id}`;
    const entry = superBy.get(key) ??
      { user_id: i.user_id, trade_name: i.trade_name, c: 0 };
    entry.c += cents(i.money!.super_amount);
    superBy.set(key, entry);
  }

  const held = await reads.heldLines(orgId, week);
  const byReason = new Map<string, { lines: number; c: number }>();
  for (const l of held) {
    // A held line with no amount is unreadable, never counted as 0.
    const raw = l.line_total_ex;
    const amount = typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
      ? Number(raw)
      : NaN;
    if (!Number.isFinite(amount)) throw unreadable("a held line's amount");
    const reason = l.hold_reason ?? "unknown";
    const e = byReason.get(reason) ?? { lines: 0, c: 0 };
    e.lines += 1;
    e.c += cents(amount);
    byReason.set(reason, e);
  }

  return {
    ok: true,
    week_start: week,
    cut_off: payRunCutOff(week),
    run: run ?? null,
    can_approve: true, // only an approver reaches this answer
    stage,
    counts: {
      clean: clean.length,
      stopped: items.length - clean.length,
      late: late.length,
      // Every stopped group named with its invoice count (for example an open
      // job with no work order, or a work order with no agreed amount), so no
      // group is lost inside the total. An invoice with two stops counts once
      // under each.
      stopped_by_code: stoppedByCode(items),
      // Every noted group, clean or stopped (for example an hourly line on a
      // job whose work order has no agreed amount). A note does not stop.
      noted_by_code: notedByCode(items),
    },
    totals: {
      total_inc_super: sum((m) => m.total_inc_super),
      paid_to_you: sum((m) => m.paid_to_you),
      super: sum((m) => m.super_amount),
      gst: sum((m) => m.gst),
      reimbursements: sum((m) => m.reimbursements),
      into_bank: sum((m) => m.into_bank),
    },
    held: {
      lines_waiting: held.length,
      amount_ex: fromCents([...byReason.values()].reduce((t, e) => t + e.c, 0)),
      by_reason: [...byReason.entries()]
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([reason, e]) => ({
          reason,
          lines: e.lines,
          amount_ex: fromCents(e.c),
        })),
    },
    invoices: items
      .sort((a, b) =>
        (a.verdict === b.verdict ? 0 : a.verdict === "stopped" ? -1 : 1) ||
        a.trade_name.localeCompare(b.trade_name) ||
        (a.invoice_id < b.invoice_id ? -1 : 1)
      )
      .map((i) => ({
        invoice_id: i.invoice_id,
        invoice_number: i.invoice_number,
        kind: i.kind,
        user_id: i.user_id,
        trade_name: i.trade_name,
        week_start: i.week_start,
        total_inc_super: i.money?.total_inc_super ?? null,
        paid_to_you: i.money?.paid_to_you ?? null,
        super_amount: i.money?.super_amount ?? null,
        reimbursements: i.money?.reimbursements ?? null,
        gst: i.money?.gst ?? null,
        into_bank: i.money?.into_bank ?? null,
        verdict: i.verdict,
        stops: i.stops,
        notes: i.notes,
        xero_bill_id: i.xero_bill_id,
        pushed: i.pushed,
      })),
    late_invoices: late.map((r) => ({
      invoice_id: String(r.id),
      invoice_number: r.invoice_number ?? null,
      user_id: r.user_id ?? null,
      submitted_at: sentAt(r),
    })),
    super_by_person: [...superBy.values()]
      .sort((a, b) => a.trade_name.localeCompare(b.trade_name))
      .map((e) => ({
        user_id: e.user_id,
        trade_name: e.trade_name,
        super_amount: fromCents(e.c),
      })),
    standing: standing.checks,
    run_blocked: standing.run_blocked,
    run_blocked_words: standing.run_blocked_words,
    clean_ids_hash: await cleanIdsHash(
      clean.map((i) => ({
        invoice_id: i.invoice_id,
        into_bank: i.money!.into_bank,
      })),
    ),
  };
}

// ════════════════════════════════════════════════════════════
// Approve the run in one press (P1-10.3).
//
//   approve_pay_run  POST { week_start, expected_clean_ids_hash }
//
// A named approver approves every clean invoice of a week, only if the week
// still reads exactly as they were shown it. The server re-reads the week
// with readPayRun (never a list of ids from the client), compares the hash,
// and hands its own snapshot to approve_trade_pay_run (P1-10.1), which locks
// the invoices, re-checks every figure and writes the run in one transaction.
// Nothing here calls Xero, writes a bill or bank file, or sends anything:
// approved invoices wait for P1-10.5's push, one per press.
// After the run is recorded, the office list gets one item per stopped
// invoice and loses the item of each invoice that is clean now. Those are
// best effort: a failed raise or withdraw is logged (codes and ids only) and
// never undoes the approval.
// ════════════════════════════════════════════════════════════

export const PAY_RUN_SWITCH = "trade_pay_run_v1";
export const PAY_RUN_CHECK_RULE = "trade-pay-check-v2+pay-run-standing-v1";
export const PAY_RUN_RAISED_BY = "phase1:pay_run";

const HASH_RE = /^[0-9a-f]{64}$/;

const NOT_APPROVER_WORDS =
  "Only the bookkeeper and the owner can approve the run.";
const CHANGED_WORDS =
  "The pay run changed since you opened it. Check it again.";

const notApprover = () =>
  new TradePayRunError("pay_run_not_approver", NOT_APPROVER_WORDS, 403);
const changedSinceShown = () =>
  new TradePayRunError("pay_run_changed_since_shown", CHANGED_WORDS, 409);

/** A refusal that carries more than a code and words (the blocked run). */
export class TradePayRunRefusal extends TradePayRunError {
  extra: Record<string, unknown>;
  constructor(
    code: string,
    message: string,
    status: number,
    extra: Record<string, unknown>,
  ) {
    super(code, message, status);
    this.extra = extra;
  }
}

export type ReconcileRaise = {
  kind: string;
  subject_table: string;
  subject_id: string;
  job_ids: string[];
  suggestion: Record<string, unknown>;
  evidence: Record<string, unknown>;
  raised_by: string;
};

export type ReconcileWithdraw = {
  kind: string;
  subject_table: string;
  subject_id: string;
  reason: string;
};

export type PayRunApproveDeps = {
  reads: PayRunReads;
  /** trade_pay_run_v1; an unreadable switch reads off. */
  switchOn(): Promise<boolean>;
  /** rpc approve_trade_pay_run; the PostgREST answer as it came. */
  approve(params: {
    p_org_id: string;
    p_week_start: string;
    p_actor: string;
    p_snapshot: Record<string, unknown>;
  }): Promise<{ data: any; error: { message?: string } | null }>;
  /** Each throws on any failure; the caller logs and goes on. */
  raise(item: ReconcileRaise): Promise<void>;
  withdraw(item: ReconcileWithdraw): Promise<void>;
  /** Lines of these invoices: their jobs, in line order. */
  invoiceJobs(
    invoiceIds: string[],
  ): Promise<
    Array<
      {
        trade_invoice_id: string;
        job_id: string | null;
        job_number: string | null;
      }
    >
  >;
  userRoles(userIds: string[]): Promise<Array<{ id: string; role: unknown }>>;
  log(line: Record<string, unknown>): void;
};

const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/**
 * What approve_trade_pay_run reads as "pays" from a stored row: net pay, plus
 * GST when GST is on, less the stored recurring deduction, to the cent. null
 * when a figure it needs is missing (never read as 0).
 */
export function storedRunPays(row: Record<string, any>): number | null {
  const net = num(row.net_pay);
  if (net === null || typeof row.gst_on !== "boolean") return null;
  let gst = 0;
  if (row.gst_on) {
    const g = num(row.gst);
    if (g === null) return null;
    gst = g;
  }
  const rawDeduction = row.recurring_deduction_amount;
  let deduction = 0;
  if (
    rawDeduction !== null && rawDeduction !== undefined && rawDeduction !== ""
  ) {
    const d = num(rawDeduction);
    if (d === null) return null;
    deduction = d;
  }
  return fromCents(cents(net) + cents(gst) - cents(deduction));
}

/**
 * The snapshot approve_trade_pay_run records, built from the server's own
 * fresh read. A clean invoice carries what it pays into the bank and its
 * super, as shown. A stopped invoice carries what was shown, or, when its
 * figures could not be read for the screen, the stored figures the database
 * reads; with neither the approval is refused (never an invented 0).
 */
export function payRunSnapshot(
  fresh: any,
  stoppedRows: Map<string, Record<string, any>>,
): Record<string, unknown> {
  const invoices = (fresh.invoices as any[]).map((i) => {
    const entry: Record<string, unknown> = {
      invoice_id: i.invoice_id,
      verdict: i.verdict,
      stops: i.stops,
    };
    if (i.verdict === "clean") {
      entry.pays = i.into_bank;
      entry.super_amount = i.super_amount;
      return entry;
    }
    let pays = num(i.into_bank);
    let superAmount = num(i.super_amount);
    if (pays === null || superAmount === null) {
      const row = stoppedRows.get(i.invoice_id);
      pays = row ? storedRunPays(row) : null;
      superAmount = row ? num(row.super_amount) : null;
    }
    if (pays === null || superAmount === null) {
      throw new TradePayRunError(
        "pay_run_stopped_figures_unreadable",
        "A stopped invoice's stored pay figures could not be read, so the run is not recorded. Check it by hand.",
        503,
      );
    }
    entry.pays = pays;
    entry.super_amount = superAmount;
    return entry;
  });
  return { check_rule: PAY_RUN_CHECK_RULE, invoices };
}

/** The difference the standing checks name for pay against job cost, or null. */
function runDifference(standing: unknown): number | null {
  if (!Array.isArray(standing)) return null;
  const c = standing.find((x: any) => x?.code === "pay_equals_job_cost");
  const expected = num(c?.expected);
  const actual = num(c?.actual);
  if (expected === null || actual === null) return null;
  return fromCents(Math.abs(cents(expected) - cents(actual)));
}

/** An empty week cannot close: a run with no clean invoice pays nobody and
 * would lock the week (cl-1622-fix). */
export const PAY_RUN_NOTHING_CLEAN_CODE = "pay_run_nothing_clean";
const nothingClean = () =>
  new TradePayRunError(
    PAY_RUN_NOTHING_CLEAN_CODE,
    "No invoice in this week is ready to pay, so the pay run cannot be approved.",
    409,
  );

const RPC_REFUSALS: Record<string, () => TradePayRunError> = {
  pay_run_not_approver: notApprover,
  pay_run_already_approved: () =>
    new TradePayRunError(
      "pay_run_already_approved",
      "This week's pay run is already approved.",
      409,
    ),
  pay_run_changed_since_shown: changedSinceShown,
  pay_run_nothing_clean: nothingClean,
  pay_run_week_invalid: () =>
    new TradePayRunError(
      "pay_run_week_invalid",
      "week_start must be a Monday, YYYY-MM-DD",
      400,
    ),
};

/** The one code a refused approve_trade_pay_run raised, or null. */
export function approveRpcCode(
  error: { message?: string } | null,
): string | null {
  const m = String(error?.message ?? "");
  const found = m.match(
    /\b(pay_run_[a-z_]+)\b/,
  );
  return found ? found[1] : null;
}

export async function approvePayRun(
  deps: PayRunApproveDeps,
  opts: {
    orgId: string | null | undefined;
    weekStart: unknown;
    expectedHash: unknown;
    /** The verified signed-in user (resolveRequestActor source jwt), else null. */
    actorUserId: string | null | undefined;
    now?: Date;
  },
): Promise<Record<string, unknown>> {
  if (!(await deps.switchOn())) {
    throw new TradePayRunError(
      "pay_run_switch_off",
      "The weekly pay run is switched off.",
      409,
    );
  }
  const actor = String(opts.actorUserId ?? "").trim();
  if (!UUID_RE.test(actor)) {
    throw new TradePayRunError(
      "pay_run_named_person_required",
      "A pay run is approved by a signed-in person, never by the server key alone.",
      403,
    );
  }
  // The week is named by the press, never defaulted: the approver approves
  // the week they were shown.
  const weekRaw = typeof opts.weekStart === "string"
    ? opts.weekStart.trim()
    : "";
  if (weekRaw === "") {
    throw new TradePayRunError(
      "pay_run_week_invalid",
      "week_start must be a Monday, YYYY-MM-DD",
      400,
    );
  }
  const expected = typeof opts.expectedHash === "string"
    ? opts.expectedHash.trim().toLowerCase()
    : "";
  if (!HASH_RE.test(expected)) {
    throw new TradePayRunError(
      "pay_run_hash_required",
      "expected_clean_ids_hash must be the hash the pay run read returned.",
      400,
    );
  }

  // Re-read the week exactly as pay_run does. The approver check inside runs
  // before any pay is read.
  let fresh: any;
  try {
    fresh = await readPayRun(deps.reads, {
      orgId: opts.orgId,
      weekStart: weekRaw,
      actorUserId: actor,
      now: opts.now,
    });
  } catch (e) {
    if (e instanceof TradePayRunError && e.code === "pay_run_approver_only") {
      throw notApprover();
    }
    throw e;
  }
  const orgId = String(opts.orgId).trim();
  const week = String(fresh.week_start);

  if (fresh.run) throw RPC_REFUSALS.pay_run_already_approved();
  if (fresh.clean_ids_hash !== expected) throw changedSinceShown();

  if (fresh.run_blocked === true) {
    const words = typeof fresh.run_blocked_words === "string"
      ? fresh.run_blocked_words
      : "Pay and job cost differ across this pay run.";
    await raiseQuietly(deps, {
      kind: "pay_run_stopped",
      subject_table: "trade_pay_run_weeks",
      subject_id: `${orgId}:${week}`,
      job_ids: [],
      suggestion: { action: "find_the_difference" },
      evidence: {
        reason: "run_total_mismatch",
        amount_ex: runDifference(fresh.standing),
        document_date: week,
        summary: { words, week_start: week },
        standing: fresh.standing,
      },
      raised_by: PAY_RUN_RAISED_BY,
    });
    throw new TradePayRunRefusal(
      "pay_run_standing_check_failed",
      words,
      409,
      { run_blocked_words: words },
    );
  }

  const stopped = (fresh.invoices as any[]).filter((i) =>
    i.verdict === "stopped"
  );
  const cleanIds = (fresh.invoices as any[]).filter((i) =>
    i.verdict === "clean"
  ).map((i) => String(i.invoice_id));
  // Refused before any write; the database refuses it too.
  if (cleanIds.length === 0) throw nothingClean();
  const stoppedRows = new Map<string, Record<string, any>>();
  if (stopped.length > 0) {
    for (
      const r of await deps.reads.invoicesById(
        stopped.map((i) => String(i.invoice_id)),
      )
    ) stoppedRows.set(String(r.id), r);
  }
  const snapshot = payRunSnapshot(fresh, stoppedRows);

  const { data, error } = await deps.approve({
    p_org_id: orgId,
    p_week_start: week,
    p_actor: actor,
    p_snapshot: snapshot,
  });
  if (error) {
    const code = approveRpcCode(error);
    deps.log({
      event: "pay_run_approve_refused",
      code: code ?? "unknown",
      week_start: week,
    });
    if (code === "pay_run_standing_check_failed") {
      const words = typeof fresh.run_blocked_words === "string"
        ? fresh.run_blocked_words
        : "The standing checks stopped this pay run. Check it again.";
      throw new TradePayRunRefusal(code, words, 409, {
        run_blocked_words: words,
      });
    }
    if (code && RPC_REFUSALS[code]) throw RPC_REFUSALS[code]();
    throw new TradePayRunError(
      code ?? "pay_run_approve_failed",
      "The pay run answer could not be read. Open the pay run again to see whether it was recorded.",
      503,
    );
  }
  const runId = typeof data?.run_id === "string" ? data.run_id : null;
  if (!runId) {
    // The rpc answered without a run: never report one as recorded.
    deps.log({ event: "pay_run_approve_unreadable_answer", week_start: week });
    throw new TradePayRunError(
      "pay_run_approve_failed",
      "The pay run answer could not be read. Open the pay run again to see whether it was recorded.",
      503,
    );
  }
  deps.log({ event: "pay_run_approved", run_id: runId, week_start: week });

  const office = await officeItemsAfterApproval(deps, {
    week,
    runId,
    stopped,
    stoppedRows,
    cleanIds,
  });

  return {
    ok: true,
    week_start: week,
    run: {
      run_id: runId,
      week_start: week,
      invoice_count: data.invoice_count ?? null,
      stopped_count: data.stopped_count ?? null,
      approved_count: data.approved_count ?? null,
    },
    clean_invoice_ids: [...cleanIds].sort(),
    office_items: office,
  };
}

async function raiseQuietly(
  deps: PayRunApproveDeps,
  item: ReconcileRaise,
): Promise<boolean> {
  try {
    await deps.raise(item);
    return true;
  } catch (e) {
    deps.log({
      event: "pay_run_office_item_failed",
      op: "raise",
      kind: item.kind,
      subject_id: item.subject_id,
      code: e instanceof TradePayRunError ? e.code : "raise_failed",
    });
    return false;
  }
}

async function officeItemsAfterApproval(
  deps: PayRunApproveDeps,
  ctx: {
    week: string;
    runId: string;
    stopped: any[];
    stoppedRows: Map<string, Record<string, any>>;
    cleanIds: string[];
  },
): Promise<{ raised: number; withdrawn: number; failed: number }> {
  const out = { raised: 0, withdrawn: 0, failed: 0 };
  let jobs: Awaited<ReturnType<PayRunApproveDeps["invoiceJobs"]>> | null = [];
  let roles = new Map<string, unknown>();
  if (ctx.stopped.length > 0) {
    try {
      jobs = await deps.invoiceJobs(
        ctx.stopped.map((i) => String(i.invoice_id)),
      );
    } catch {
      // Without the jobs an item would name none: it is not raised.
      deps.log({
        event: "pay_run_office_item_failed",
        op: "read_jobs",
        run_id: ctx.runId,
      });
      out.failed += ctx.stopped.length;
      jobs = null;
    }
    const userIds = [
      ...new Set(
        ctx.stopped.map((i) => i.user_id).filter((u): u is string =>
          typeof u === "string" && u !== ""
        ),
      ),
    ];
    try {
      roles = new Map(
        (userIds.length ? await deps.userRoles(userIds) : []).map((u) => [
          String(u.id),
          u.role,
        ]),
      );
    } catch {
      deps.log({
        event: "pay_run_office_item_failed",
        op: "read_roles",
        run_id: ctx.runId,
      });
    }
  }
  if (jobs) {
    for (const inv of ctx.stopped) {
      const id = String(inv.invoice_id);
      const own = jobs.filter((l) => String(l.trade_invoice_id) === id);
      const jobIds = [
        ...new Set(own.map((l) => l.job_id).filter((j): j is string => !!j)),
      ];
      const firstJob = own.find((l) => l.job_number)?.job_number ?? null;
      const row = ctx.stoppedRows.get(id);
      const stops = Array.isArray(inv.stops) ? inv.stops : [];
      const ok = await raiseQuietly(deps, {
        kind: "pay_claim_stopped",
        subject_table: "trade_invoices",
        subject_id: id,
        job_ids: jobIds,
        suggestion: { action: "fix_or_send_back" },
        evidence: {
          reason: stops[0]?.code ?? "stopped",
          // The stored subtotal, or null when it is missing (never 0).
          amount_ex: row ? num(row.subtotal_ex) : null,
          document_date: ctx.week,
          summary: {
            words: stops.map((s: any) => s.words).join(" "),
            trade_user_id: inv.user_id ?? null,
            trade_name: inv.trade_name ?? null,
            trade_role: inv.user_id
              ? (roles.get(String(inv.user_id)) ?? null)
              : null,
            job_number: firstJob,
            week_start: ctx.week,
          },
          stops,
        },
        raised_by: PAY_RUN_RAISED_BY,
      });
      if (ok) out.raised += 1;
      else out.failed += 1;
    }
  }
  for (const id of ctx.cleanIds) {
    try {
      await deps.withdraw({
        kind: "pay_claim_stopped",
        subject_table: "trade_invoices",
        subject_id: id,
        reason: "Clean in this pay run",
      });
      out.withdrawn += 1;
    } catch (e) {
      out.failed += 1;
      deps.log({
        event: "pay_run_office_item_failed",
        op: "withdraw",
        kind: "pay_claim_stopped",
        subject_id: id,
        code: e instanceof TradePayRunError ? e.code : "withdraw_failed",
      });
    }
  }
  return out;
}

/** The real approve dependencies, through the service client. */
export function payRunApproveDepsFromClient(
  client: any,
  switchOn: () => Promise<boolean>,
): PayRunApproveDeps {
  const rpcOrThrow = async (fn: string, args: Record<string, unknown>) => {
    const { error } = await client.rpc(fn, args);
    if (error) {
      throw new TradePayRunError(
        String(error.code ?? "rpc_failed"),
        `${fn} refused`,
        503,
      );
    }
  };
  return {
    reads: payRunReadsFromClient(client),
    switchOn,
    async approve(params) {
      const { data, error } = await client.rpc("approve_trade_pay_run", params);
      return { data, error };
    },
    // reconcile_item_raise takes its seven arguments by position (P2-03.2):
    // these names are its ALIAS names. See the PR for the open gap.
    raise: (item) =>
      rpcOrThrow("reconcile_item_raise", {
        p_kind: item.kind,
        p_subject_table: item.subject_table,
        p_subject_id: item.subject_id,
        p_job_ids: item.job_ids,
        p_suggestion: item.suggestion,
        p_evidence: item.evidence,
        p_raised_by: item.raised_by,
      }),
    withdraw: (item) =>
      rpcOrThrow("reconcile_item_withdraw", {
        p_kind: item.kind,
        p_subject_table: item.subject_table,
        p_subject_id: item.subject_id,
        p_reason: item.reason,
      }),
    async invoiceJobs(invoiceIds) {
      // idx_inv_lines_invoice, chunks of 25.
      const rows: any[] = [];
      for (const chunk of chunks(invoiceIds, ID_CHUNK)) {
        rows.push(
          ...await allPages(
            (from, to) =>
              client.from("trade_invoice_lines")
                .select("id, trade_invoice_id, job_id, job_number")
                .in("trade_invoice_id", chunk).order("id").range(from, to),
            "the stopped invoices' jobs",
          ),
        );
      }
      return rows;
    },
    async userRoles(userIds) {
      // users_pkey, chunks of 25.
      return await byIdChunks(
        userIds,
        (chunk) => client.from("users").select("id, role").in("id", chunk),
        "the trades' roles",
      );
    },
    log(line) {
      console.log(JSON.stringify(line));
    },
  };
}

// ════════════════════════════════════════════════════════════
// Push an approved run's invoice into Xero as a draft (P1-10.5).
//
//   push_pay_run_invoice     POST { run_id, invoice_id }
//   mark_pay_run_super_paid  POST { run_id }
//
// An approver pushes one clean invoice of an approved run per press, through
// the existing one-invoice push (a DRAFT bill with its PDFs, which reuses a
// bill already made for the same invoice). Nothing here authorises or pays a
// bill, calls a Xero payment endpoint, or pushes a crewmate's bill. A Xero
// failure is the push's own error; pushed_at stays null and the press can be
// repeated.
// ════════════════════════════════════════════════════════════

export type PayRunRunRow = {
  id: string;
  org_id: string;
  week_start: string;
  status: string;
  super_marked_paid_at: string | null;
  super_marked_paid_by: string | null;
};

export type PayRunPushDeps = {
  /** trade_pay_run_v1; an unreadable switch reads off. */
  switchOn(): Promise<boolean>;
  /** The approver list; throws 503 when it cannot be read. */
  approvers(): Promise<string[]>;
  /** trade_pay_runs by id, or null. Throws 503 on a failed read. */
  runById(runId: string): Promise<PayRunRunRow | null>;
  /** The run's row for this invoice, or null. Throws 503 on a failed read. */
  runInvoice(
    runId: string,
    invoiceId: string,
  ): Promise<
    | {
      verdict: string;
      pays: unknown;
      pushed_at: string | null;
      xero_bill_id: string | null;
    }
    | null
  >;
  /** The invoice's stamp, status, bill and stored pay figures, or null. */
  invoiceForPush(invoiceId: string): Promise<Record<string, any> | null>;
  /**
   * Moves a run-held invoice from the status it kept at the press
   * (pending_ops_review or queried) to approved, the status the one-invoice
   * push takes; only while the run holds it and it has no bill. True when the
   * invoice is approved after the call.
   */
  readyForRunPush(runId: string, invoiceId: string): Promise<boolean>;
  /**
   * Claims the run row for one press (claim_trade_pay_run_push, database
   * clock). Returns the claim's stamp, or null when another press holds a
   * live claim or the row is pushed. Throws 503 when the claim cannot be made.
   */
  claimPush(
    runId: string,
    invoiceId: string,
    actor: string,
  ): Promise<string | null>;
  /** Gives back this press's own claim (matched on its stamp). Best effort. */
  releasePush(
    runId: string,
    invoiceId: string,
    claimedAt: string,
  ): Promise<void>;
  /** The existing one-invoice push. Throws the push's own error. */
  push(invoiceId: string, runId: string): Promise<Record<string, unknown>>;
  /** Records the push on the run row; true when this call wrote it. */
  markPushed(runId: string, invoiceId: string, billId: string): Promise<void>;
  /** Clean rows of the run with no push yet. Throws 503 on a failed read. */
  cleanUnpushed(runId: string): Promise<number>;
  /** approved -> pushed; does nothing once it is pushed. */
  markRunPushed(runId: string): Promise<void>;
  /** Stamps super paid once; returns the row's stamp either way. */
  markSuperPaid(
    runId: string,
    actor: string,
  ): Promise<{ super_marked_paid_at: string; super_marked_paid_by: string }>;
  log(line: Record<string, unknown>): void;
};

async function payRunPressGate(
  deps: Pick<PayRunPushDeps, "switchOn" | "approvers" | "runById">,
  opts: {
    orgId: string | null | undefined;
    actorUserId: string | null | undefined;
    runId: unknown;
  },
): Promise<{ actor: string; run: PayRunRunRow }> {
  if (!(await deps.switchOn())) {
    throw new TradePayRunError(
      "pay_run_switch_off",
      "The weekly pay run is switched off.",
      409,
    );
  }
  const actor = String(opts.actorUserId ?? "").trim();
  if (!UUID_RE.test(actor)) {
    throw new TradePayRunError(
      "pay_run_named_person_required",
      "A pay run is pushed by a signed-in person, never by the server key alone.",
      403,
    );
  }
  // Same check as the approval: the approver list, before anything is read.
  if (!(await deps.approvers()).includes(actor)) throw notApprover();
  const runId = typeof opts.runId === "string" ? opts.runId.trim() : "";
  if (!UUID_RE.test(runId)) {
    throw new TradePayRunError(
      "pay_run_id_invalid",
      "run_id must be the pay run's id.",
      400,
    );
  }
  const orgId = String(opts.orgId ?? "").trim();
  const run = await deps.runById(runId);
  if (!run || !UUID_RE.test(orgId) || String(run.org_id) !== orgId) {
    throw new TradePayRunError(
      "pay_run_not_found",
      "No pay run with that id.",
      404,
    );
  }
  return { actor, run };
}

export async function pushPayRunInvoice(
  deps: PayRunPushDeps,
  opts: {
    orgId: string | null | undefined;
    actorUserId: string | null | undefined;
    runId: unknown;
    invoiceId: unknown;
  },
): Promise<Record<string, unknown>> {
  const { actor, run } = await payRunPressGate(deps, opts);
  const invoiceId = typeof opts.invoiceId === "string"
    ? opts.invoiceId.trim()
    : "";
  if (!UUID_RE.test(invoiceId)) {
    throw new TradePayRunError(
      "pay_run_invoice_invalid",
      "invoice_id must be an invoice of the run.",
      400,
    );
  }
  const row = await deps.runInvoice(run.id, invoiceId);
  if (!row) {
    throw new TradePayRunError(
      "invoice_not_in_run",
      "That invoice is not in this pay run.",
      409,
    );
  }
  if (row.verdict !== "clean") {
    throw new TradePayRunError(
      "invoice_not_clean",
      "That invoice was stopped in this pay run, so it is not pushed.",
      409,
    );
  }
  // Already pushed on this run: say so, call nothing.
  if (row.pushed_at) {
    return {
      ok: true,
      run_id: run.id,
      invoice_id: invoiceId,
      xero_bill_id: row.xero_bill_id,
      already_pushed: true,
      run_status: run.status,
    };
  }
  // The invoice itself must still be the run's (a clean row is unique per
  // invoice; this reads the stamp the approval wrote).
  const inv = await deps.invoiceForPush(invoiceId);
  if (!inv || String(inv.pay_run_id ?? "") !== run.id) {
    throw new TradePayRunError(
      "invoice_not_in_run",
      "That invoice is not in this pay run.",
      409,
    );
  }
  // A bill already made for this invoice (an earlier press whose record did
  // not land, or another door): record it, never call Xero again.
  const existingBill = String(inv.xero_bill_id ?? "").trim();
  if (
    existingBill !== "" &&
    ["pushed_to_xero", "paid"].includes(String(inv.status ?? ""))
  ) {
    return await recordPushed(deps, run, invoiceId, existingBill, actor, {
      recorded_existing_bill: true,
      pdf_attached: null,
    });
  }
  // The invoice must still pay what the run recorded, to the cent. A figure
  // that cannot be read refuses; a changed one (for example a repayment
  // re-checked since the press) is never sent to Xero.
  const runPays = num(row.pays);
  const assertRunPays = (candidate: Record<string, unknown>) => {
    const nowPays = storedRunPays(candidate);
    if (nowPays === null || runPays === null) {
      throw unreadable("the invoice's pay figures");
    }
    if (cents(nowPays) !== cents(runPays)) {
      deps.log({
        at: "push_pay_run_invoice",
        outcome: "pays_changed",
        run_id: run.id,
        invoice_id: invoiceId,
      });
      throw new TradePayRunError(
        "pay_run_pays_changed",
        "This invoice no longer pays what the run approved. It is not pushed; the office needs to check it.",
        409,
      );
    }
  };
  // Checked before the move, so a change already made never moves the invoice.
  assertRunPays(inv);
  // Director 15:22 (b): one press at a time per invoice. The claim is a row
  // on trade_pay_run_invoices stamped by the database clock; a second press
  // while it is live is refused and calls nothing, so two presses never rely
  // on Xero's duplicate guard alone. A refusal before the Xero call gives the
  // claim back. Once Xero is called the outcome may be unknown, so the claim
  // is kept and lapses after ten minutes (claim_trade_pay_run_push), so it is
  // never stuck for good.
  const claimedAt = await deps.claimPush(run.id, invoiceId, actor);
  if (!claimedAt) {
    deps.log({
      at: "push_pay_run_invoice",
      outcome: "push_in_progress",
      run_id: run.id,
      invoice_id: invoiceId,
    });
    throw new TradePayRunError(
      "pay_run_push_in_progress",
      "This invoice is already being pushed. Wait a few minutes, then open the pay run again.",
      409,
    );
  }
  try {
    await moveForRunPush();
  } catch (e) {
    await deps.releasePush(run.id, invoiceId, claimedAt).catch(() => {
      deps.log({
        at: "push_pay_run_invoice",
        outcome: "claim_release_failed",
        run_id: run.id,
        invoice_id: invoiceId,
      });
    });
    throw e;
  }
  async function moveForRunPush() {
    // Option A: the run's invoice kept its press status. The run's push moves it
    // to approved first (the repayment check runs on that move), then reads the
    // figures again and checks them once more.
    if (String(inv!.status ?? "") !== "approved") {
      if (!(await deps.readyForRunPush(run.id, invoiceId))) {
        throw new TradePayRunError(
          "invoice_changed",
          "This invoice changed since the run was approved. Open the pay run again.",
          409,
        );
      }
      const again = await deps.invoiceForPush(invoiceId);
      if (!again || String(again.pay_run_id ?? "") !== run.id) {
        throw new TradePayRunError(
          "invoice_not_in_run",
          "That invoice is not in this pay run.",
          409,
        );
      }
      assertRunPays(again);
    }
  }

  let pushed: Record<string, unknown>;
  try {
    pushed = await deps.push(invoiceId, run.id);
  } catch (e) {
    deps.log({
      at: "push_pay_run_invoice",
      outcome: "push_failed",
      run_id: run.id,
      invoice_id: invoiceId,
      code: (e as { body?: { code?: unknown } })?.body?.code ?? null,
    });
    throw e;
  }
  const billId = typeof pushed?.xero_bill_id === "string"
    ? pushed.xero_bill_id.trim()
    : "";
  if (billId === "") {
    // The push answered without a bill: nothing is recorded as pushed.
    throw new TradePayRunError(
      "pay_run_push_unconfirmed",
      "Xero did not confirm a draft bill for this invoice. Check Xero before pushing it again.",
      502,
    );
  }
  return await recordPushed(deps, run, invoiceId, billId, actor, {
    recorded_existing_bill: false,
    pdf_attached: pushed?.pdf_attached ?? null,
  });
}

async function recordPushed(
  deps: PayRunPushDeps,
  run: PayRunRunRow,
  invoiceId: string,
  billId: string,
  actor: string,
  extra: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await deps.markPushed(run.id, invoiceId, billId);
  let runStatus = run.status;
  if ((await deps.cleanUnpushed(run.id)) === 0) {
    await deps.markRunPushed(run.id);
    runStatus = "pushed";
  }
  deps.log({
    at: "push_pay_run_invoice",
    outcome: extra.recorded_existing_bill ? "recorded_existing_bill" : "pushed",
    run_id: run.id,
    invoice_id: invoiceId,
    actor,
    run_status: runStatus,
  });
  return {
    ok: true,
    run_id: run.id,
    invoice_id: invoiceId,
    xero_bill_id: billId,
    already_pushed: false,
    run_status: runStatus,
    ...extra,
  };
}

export async function markPayRunSuperPaid(
  deps: PayRunPushDeps,
  opts: {
    orgId: string | null | undefined;
    actorUserId: string | null | undefined;
    runId: unknown;
  },
): Promise<Record<string, unknown>> {
  const { actor, run } = await payRunPressGate(deps, opts);
  if (run.super_marked_paid_at) {
    return {
      ok: true,
      run_id: run.id,
      super_marked_paid_at: run.super_marked_paid_at,
      super_marked_paid_by: run.super_marked_paid_by,
      already_marked: true,
    };
  }
  if (run.status !== "pushed") {
    throw new TradePayRunError(
      "pay_run_not_pushed",
      "Push every clean invoice of the run to Xero before marking its super paid.",
      409,
    );
  }
  const stamp = await deps.markSuperPaid(run.id, actor);
  return {
    ok: true,
    run_id: run.id,
    ...stamp,
    already_marked: stamp.super_marked_paid_by !== actor,
  };
}

/** The real reads and writes, through the service client. */
export function payRunPushDepsFromClient(
  client: any,
  switchOn: () => Promise<boolean>,
  push: (invoiceId: string, runId: string) => Promise<Record<string, unknown>>,
): PayRunPushDeps {
  const reads = payRunReadsFromClient(client);
  const writeFailed = (what: string) =>
    new TradePayRunError(
      "pay_run_write_failed",
      `The pay run could not be updated (${what}). Open the pay run again.`,
      503,
    );
  return {
    switchOn,
    approvers: () => reads.approvers(),
    async runById(runId) {
      // trade_pay_runs_pkey.
      const { data, error } = await client.from("trade_pay_runs")
        .select(
          "id, org_id, week_start, status, super_marked_paid_at, super_marked_paid_by",
        )
        .eq("id", runId).maybeSingle();
      if (error) throw unreadable("the run record");
      return data ?? null;
    },
    async runInvoice(runId, invoiceId) {
      // trade_pay_run_invoices_pkey (run_id, invoice_id).
      const { data, error } = await client.from("trade_pay_run_invoices")
        .select("verdict, pays, pushed_at, xero_bill_id")
        .eq("run_id", runId).eq("invoice_id", invoiceId).maybeSingle();
      if (error) throw unreadable("the run's invoice");
      return data ?? null;
    },
    async invoiceForPush(invoiceId) {
      // trade_invoices_pkey.
      const { data, error } = await client.from("trade_invoices")
        .select(
          "pay_run_id, status, xero_bill_id, net_pay, gst, gst_on, recurring_deduction_amount",
        ).eq("id", invoiceId).maybeSingle();
      if (error) throw unreadable("the invoice");
      return data ?? null;
    },
    async claimPush(runId, invoiceId, actor) {
      // trade_pay_run_invoices_pkey; the database clock decides the lease.
      const { data, error } = await client.rpc("claim_trade_pay_run_push", {
        p_run_id: runId,
        p_invoice_id: invoiceId,
        p_actor: actor,
      });
      if (error) throw writeFailed("the push claim");
      return typeof data === "string" && data !== "" ? data : null;
    },
    async releasePush(runId, invoiceId, claimedAt) {
      const { error } = await client.rpc("release_trade_pay_run_push", {
        p_run_id: runId,
        p_invoice_id: invoiceId,
        p_claimed_at: claimedAt,
      });
      if (error) throw writeFailed("the push claim");
    },
    async readyForRunPush(runId, invoiceId) {
      // trade_invoices_pkey; only the run's own held invoice moves.
      const { data, error } = await client.from("trade_invoices")
        .update({ status: "approved" })
        .eq("id", invoiceId)
        .eq("pay_run_id", runId)
        .in("status", ["pending_ops_review", "queried"])
        .is("xero_bill_id", null)
        .select("id, status")
        .maybeSingle();
      if (error) throw writeFailed("the invoice status");
      return data?.status === "approved";
    },
    push,
    async markPushed(runId, invoiceId, billId) {
      // trade_pay_run_invoices_pkey; a second writer finds pushed_at set.
      const { error } = await client.from("trade_pay_run_invoices")
        .update({ pushed_at: new Date().toISOString(), xero_bill_id: billId })
        .eq("run_id", runId).eq("invoice_id", invoiceId).eq("verdict", "clean")
        .is("pushed_at", null);
      if (error) throw writeFailed("the pushed invoice");
    },
    async cleanUnpushed(runId) {
      // trade_pay_run_invoices_pkey leads with run_id.
      const { count, error } = await client.from("trade_pay_run_invoices")
        .select("invoice_id", { count: "exact", head: true })
        .eq("run_id", runId).eq("verdict", "clean").is("pushed_at", null);
      if (error || typeof count !== "number") {
        throw unreadable("the run's unpushed invoices");
      }
      return count;
    },
    async markRunPushed(runId) {
      // trade_pay_runs_pkey.
      const { error } = await client.from("trade_pay_runs")
        .update({ status: "pushed" }).eq("id", runId).eq("status", "approved");
      if (error) throw writeFailed("the run status");
    },
    async markSuperPaid(runId, actor) {
      // trade_pay_runs_pkey. Only the first stamp is kept.
      const { data, error } = await client.from("trade_pay_runs")
        .update({
          super_marked_paid_at: new Date().toISOString(),
          super_marked_paid_by: actor,
        })
        .eq("id", runId).eq("status", "pushed").is("super_marked_paid_at", null)
        .select("super_marked_paid_at, super_marked_paid_by").maybeSingle();
      if (error) throw writeFailed("the super stamp");
      if (data?.super_marked_paid_at) return data;
      const { data: again, error: againErr } = await client.from(
        "trade_pay_runs",
      )
        .select("super_marked_paid_at, super_marked_paid_by")
        .eq("id", runId).maybeSingle();
      if (againErr || !again?.super_marked_paid_at) {
        throw unreadable("the super stamp");
      }
      return again;
    },
    log(line) {
      console.log(JSON.stringify(line));
    },
  };
}
