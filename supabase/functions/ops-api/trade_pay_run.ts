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

function validV2(
  data: any,
  stage: string,
): Map<string, { verdict: string; stops: Stop[]; trade_name: string }> {
  if (
    !data || typeof data !== "object" || data.rule !== "trade-pay-check-v2" ||
    data.stage !== stage || !Array.isArray(data.invoices)
  ) throw unreadable("pay-run check v2");
  const out = new Map<
    string,
    { verdict: string; stops: Stop[]; trade_name: string }
  >();
  for (const inv of data.invoices) {
    const stops = stopsOf(inv?.stops);
    if (
      !inv || typeof inv.invoice_id !== "string" || !stops ||
      inv.verdict !== (stops.length > 0 ? "stopped" : "clean")
    ) throw unreadable("pay-run check v2");
    out.set(inv.invoice_id, {
      verdict: inv.verdict,
      stops,
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
const MONEY_UNREADABLE: Stop = {
  code: "money_unreadable",
  words: "This invoice's pay figures do not add up. Check it by hand.",
};

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
    xero_bill_id: string | null;
    pushed: boolean;
  };
  const items: Item[] = rows.map((row) => {
    const id = String(row.id);
    const payWeek = invoicePayWeek(row);
    const found = v2.get(id);
    let stops: Stop[];
    let tradeName = "A trade";
    if (found) {
      stops = [...found.stops];
      tradeName = found.trade_name;
    } else if (payWeek && payWeek < fromWeek) {
      stops = [OLDER_THAN_WINDOW];
    } else {
      // Inside the window and missing from the check: never shown as clean.
      throw unreadable("pay-run check v2 left out an invoice of this week");
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
