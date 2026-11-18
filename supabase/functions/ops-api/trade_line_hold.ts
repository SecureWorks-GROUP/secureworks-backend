// P1-05.7/P1-05.8: the held-line send's sorter. This module never saves,
// sends or changes a work order. Only the facts reader performs I/O.
// deno-lint-ignore-file no-explicit-any
import {
  commissionLineState,
  type JobCommissionRecord,
} from "./job_commission.ts";
import {
  countsAgainstWorkOrder,
  readWorkOrderBackedBilled,
} from "./work_order_total_cap.ts";
import { decideTradeInvoiceMode } from "./trade_invoice_mode.ts";
import { budgetLabourPay, JOB_LABOUR_BUDGET_FLAG } from "./job_labour_cap.ts";
import { isRestorationCard } from "./restoration_workflow_store.ts";
import {
  extraLineRateHold,
  type ExtraRateRules,
} from "./trade_invoice_extra_rate_rule.ts";
import { isTradeInvoiceTimeLineType } from "./trade_invoice_time_entry.ts";
import { readWorkOrderCapScope } from "./work_order_cap_scope.ts";

export const HOLD_REASONS = [
  "no_work_order",
  "no_amount",
  "over_amount",
  "hourly_no_maximum",
  "no_job",
  "not_job_work",
  "reimbursement",
  "not_on_crew",
  "commission_no_figure",
  "rate_above_rule",
] as const;
export type HoldReason = typeof HOLD_REASONS[number];
export const HOLD_WORDS: Record<HoldReason, string> = {
  no_work_order: "With the office: this job has no work order yet.",
  no_amount: "With the office: this job's work order has no amount yet.",
  over_amount:
    "With the office: this job's amount is used up. <left> was left, so <held> is waiting.",
  hourly_no_maximum:
    "With the office: this job has no maximum for hourly work yet.",
  no_job: "With the office: this line is not on a job.",
  not_job_work: "With the office: <type label> is waiting for approval.",
  reimbursement: "With the office: this receipt is waiting for approval.",
  not_on_crew:
    "With the office: you added yourself to this job and its crew or the office has not accepted that.",
  commission_no_figure:
    "With the office: the commission for this job has no figure yet.",
  rate_above_rule: "With the office: this amount is above the usual rate.",
};

/** Lines are already server-normalised and priced, as for today's cap. In
 * particular rate_source is server-owned, not a claim accepted from the wire. */
export type HoldLine = {
  job_id?: string | null;
  line_type: string;
  line_total_ex: number;
  rate?: number;
  rate_source?: string;
  total_hours?: number | null;
  quantity?: number;
  week_start?: string;
  work_date?: string;
  description?: string;
  expense_receipt_id?: string | null;
  not_job_work_type_id?: string | null;
  suggested?: unknown;
  [key: string]: any;
};
export type JobHoldFacts = {
  job_number: string | null;
  workOrder: { id: string; status: string; agreed_ex: number | null } | null;
  allowed_ex: number;
  backed_billed_ex: number;
  hourly: boolean;
  /** Follow-up 49 item 9(b): false when the job is outside the cap's scope
   * (no start date; or an order approved before it; or no approved order on a
   * job created before it), so no work order reason holds its lines. The
   * reader always sets it; absent keeps the earlier rule (every job capped). */
  cap_in_scope?: boolean;
  off_crew?: boolean;
  /** Reader keys crew decisions by week so a different week's rejection
   * never holds this week's work. off_crew is the single-week shorthand. */
  off_crew_by_week?: Record<string, boolean>;
};
export type LineHoldFacts = {
  userId: string;
  jobs: Record<string, JobHoldFacts>;
  receipts: Record<string, { approved: boolean }>;
  notJobTypes: Record<string, string>;
  commissions: Record<string, JobCommissionRecord | null>;
  rateRules: ExtraRateRules;
  tradeRates: Array<
    { hourly_rate: number; effective_from: string; effective_to: string | null }
  >;
  /** Fresh ids prepared by the I/O boundary, one per input position. Supplying
   * them keeps classification deterministic and a retry's grouping stable. */
  split_group_ids: readonly string[];
};
export type ClassifiedLine = HoldLine & {
  sent_amount_ex: number;
  hold_reason?: HoldReason;
  hold_detail?: {
    job_number: string | null;
    allowed_ex: number | null;
    left_ex: number | null;
    asked_ex: number;
    expected: unknown;
    fallback_reason?: HoldReason | null;
  };
  words?: string;
};
const cents = (v: number) => Math.round(v * 100);
const money = (v: number) => cents(v) / 100;
const key = (v: unknown) => String(v ?? "").trim().toLowerCase();
const dollars = (v: number) => `$${money(v).toFixed(2)}`;
const week = (l: HoldLine) =>
  l.week_start ?? (l.work_date ? monday(l.work_date) : "");
function monday(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}
function datedRate(line: HoldLine, facts: LineHoldFacts): number | null {
  const day = line.work_date ?? line.week_start ?? "";
  const rows = facts.tradeRates.filter((r) =>
    r.effective_from <= day && (!r.effective_to || r.effective_to >= day)
  );
  rows.sort((a, b) => b.effective_from.localeCompare(a.effective_from));
  return rows[0]?.hourly_rate ?? null;
}
function jobReason(
  line: HoldLine,
  job: JobHoldFacts | undefined,
  left: number,
): HoldReason | null {
  // Out of the cap's scope: no work order, amount, maximum or over-amount hold.
  if (job?.cap_in_scope === false) return null;
  const hourly = job?.hourly && isTradeInvoiceTimeLineType(line.line_type);
  if (
    !job?.workOrder || !["draft", "approved"].includes(job.workOrder.status)
  ) {
    return hourly ? "hourly_no_maximum" : "no_work_order";
  }
  if (job.workOrder.status !== "approved" || job.workOrder.agreed_ex === null) {
    return hourly ? "hourly_no_maximum" : "no_amount";
  }
  return cents(line.line_total_ex) > left ? "over_amount" : null;
}

/** Pure, in input order. Missing/claimed/non-owner commission items are named
 * in skipped_items for the send response, never refused or made into pay. */
export type ClassifyOptions = {
  /** Director ruling 1 (18 Nov 2026), used by the send: keep a split only when
   * it is a same-rate split of an hours line, exact to the cent (hours times
   * rate makes the whole line, and each part, at storage precision), and the
   * line carries no start or finish time (a time entry makes its own hours).
   * Any other over-the-amount line is held whole. Default false keeps the
   * P1-05.7 sorter unchanged. */
  sameRateSplitOnly?: boolean;
};

export function classifyLines(
  lines: readonly HoldLine[],
  facts: LineHoldFacts,
  options: ClassifyOptions = {},
): {
  backed: ClassifiedLine[];
  held: ClassifiedLine[];
  skipped_items: Array<{ index: number; reason: "not_yours" | "claimed" }>;
} {
  const backed: ClassifiedLine[] = [], held: ClassifiedLine[] = [];
  const skipped_items: Array<
    { index: number; reason: "not_yours" | "claimed" }
  > = [];
  const remaining = new Map<string, number>();
  const commissionUsed = new Set<string>();
  for (const [index, input] of lines.entries()) {
    // Never carry an earlier classification into a fresh decision.
    const {
      hold_reason: _r,
      hold_detail: _d,
      words: _w,
      split_group_id: _s,
      ...raw
    } = input;
    const line = {
      ...raw,
      line_total_ex: money(input.line_total_ex),
      sent_amount_ex: money(input.line_total_ex),
    } as ClassifiedLine;
    const jobId = line.job_id ?? "", job = facts.jobs[jobId];
    if (!remaining.has(jobId)) {
      remaining.set(
        jobId,
        job ? cents(job.allowed_ex) - cents(job.backed_billed_ex) : 0,
      );
    }
    const left = remaining.get(jobId)!;
    const hold = (
      part: ClassifiedLine,
      reason: HoldReason,
      fallback?: HoldReason | null,
    ) => {
      held.push({
        ...part,
        hold_reason: reason,
        office_review_status: "awaiting",
        hold_detail: {
          job_number: job?.job_number ?? null,
          allowed_ex: job?.allowed_ex ?? null,
          left_ex: job ? Math.max(0, left) / 100 : null,
          asked_ex: key(line.line_type) === "commission"
            ? 0
            : line.line_total_ex,
          expected: line.suggested ?? null,
          ...(fallback !== undefined ? { fallback_reason: fallback } : {}),
        },
        words: HOLD_WORDS[reason].replace(
          "<left>",
          dollars(Math.max(0, left) / 100),
        )
          .replace("<held>", dollars(part.line_total_ex))
          .replace(
            "<type label>",
            facts.notJobTypes[line.not_job_work_type_id ?? ""] ?? "This work",
          ),
      });
    };
    if (key(line.line_type) === "commission") {
      const record = facts.commissions[jobId] ?? null;
      // Follow-up 31: the database checks ownership BEFORE it checks a figure.
      // A record naming nobody cannot become an approvable held claim either.
      if (record && record.salesperson_user_id !== facts.userId) {
        skipped_items.push({ index, reason: "not_yours" });
        continue;
      }
      const state = commissionLineState(record, facts.userId);
      if (
        commissionUsed.has(jobId) || state.state === "claimed" ||
        state.state === "not_yours"
      ) {
        skipped_items.push({
          index,
          reason: state.state === "not_yours" ? "not_yours" : "claimed",
        });
        continue;
      }
      if (state.state === "offer") {
        backed.push({
          ...line,
          quantity: 1,
          rate: money(state.remaining_ex),
          line_total_ex: money(state.remaining_ex),
          sent_amount_ex: money(state.remaining_ex),
        });
        commissionUsed.add(jobId);
      } else {hold({
          ...line,
          quantity: 1,
          rate: 0,
          line_total_ex: 0,
          sent_amount_ex: 0,
        }, "commission_no_figure");}
      continue;
    }
    if (key(line.line_type) === "reimbursement") {
      if (!jobId) hold(line, "no_job");
      else if (facts.receipts[line.expense_receipt_id ?? ""]?.approved) {
        backed.push(line);
      } else hold(line, "reimbursement");
      continue;
    }
    if (!jobId) {
      hold(
        line,
        facts.notJobTypes[line.not_job_work_type_id ?? ""]
          ? "not_job_work"
          : "no_job",
      );
      continue;
    }
    if (
      extraLineRateHold({
        lineType: line.line_type,
        rate: line.rate ?? 0,
        serverResolved: line.rate_source === "server_resolved",
        rules: facts.rateRules,
        tradeHourlyRate: datedRate(line, facts),
      })?.held
    ) {
      hold(line, "rate_above_rule");
      continue;
    }
    const reason = jobReason(line, job, left);
    if (job?.off_crew_by_week?.[week(line)] ?? job?.off_crew) {
      hold(line, "not_on_crew", reason);
      continue;
    }
    if (reason && reason !== "over_amount") {
      hold(line, reason);
      continue;
    }
    const asked = cents(line.line_total_ex);
    if (!reason) {
      backed.push(line);
      if (countsAgainstWorkOrder(line.line_type)) {
        remaining.set(jobId, left - asked);
      }
      continue;
    }
    if (left <= 0) {
      hold(line, "over_amount");
      continue;
    }
    const hoursLine = isTradeInvoiceTimeLineType(line.line_type);
    const hours = Number(line.total_hours ?? line.quantity ?? 0),
      rate = Number(line.rate ?? 0);
    // Whole quarter-hours only. Compare rounded cents too, since the invoice
    // stores cents and a fractional-cent rate product must never overspend.
    let backedHours = hoursLine && rate > 0
      ? Math.floor(left * 4 / cents(rate)) / 4
      : 0;
    while (backedHours >= 0.25 && cents(backedHours * rate) > left) {
      backedHours -= 0.25;
    }
    if (hoursLine && (backedHours < 0.25 || backedHours >= hours)) {
      hold(line, "over_amount");
      continue;
    }
    if (
      options.sameRateSplitOnly &&
      !exactSameRateSplit(line, hoursLine, hours, backedHours, rate, asked)
    ) {
      hold(line, "over_amount");
      continue;
    }
    const paid = hoursLine ? cents(backedHours * rate) : left;
    const split_group_id = facts.split_group_ids[index];
    const paidPart = {
      ...line,
      split_group_id,
      line_total_ex: paid / 100,
      sent_amount_ex: paid / 100,
      ...(hoursLine
        ? { total_hours: backedHours, quantity: backedHours }
        : { quantity: 1, rate: paid / 100 }),
    };
    const heldPart = {
      ...line,
      split_group_id,
      line_total_ex: (asked - paid) / 100,
      sent_amount_ex: (asked - paid) / 100,
      description: `${line.description ?? ""} (part over the job's amount)`,
      ...(hoursLine
        ? { total_hours: hours - backedHours, quantity: hours - backedHours }
        : { quantity: 1, rate: (asked - paid) / 100 }),
    };
    backed.push(paidPart);
    hold(heldPart, "over_amount");
    remaining.set(jobId, left - paid);
  }
  return { backed, held, skipped_items };
}

/** Ruling 1: the two parts must rebuild the line exactly at storage precision
 * (two decimals for hours and rate, whole cents for money). */
function exactSameRateSplit(
  line: HoldLine,
  hoursLine: boolean,
  hours: number,
  backedHours: number,
  rate: number,
  asked: number,
): boolean {
  if (!hoursLine || rate <= 0) return false;
  if (line.start_time || line.finish_time) return false;
  const r = Math.round(rate * 100) / 100;
  if (r !== rate || Math.round(hours * 100) / 100 !== hours) return false;
  const heldHours = Math.round((hours - backedHours) * 100) / 100;
  return cents(hours * r) === asked &&
    cents(backedHours * r) + cents(heldHours * r) === asked;
}

export class LineHoldFactsUnreadable extends Error {
  readonly status = 503;
  readonly code = "pay_facts_unreadable";
  constructor() {
    super(
      "Could not check your jobs just now. Nothing was sent. Try again in a minute.",
    );
    this.name = "LineHoldFactsUnreadable";
  }
}
const numeric = (value: unknown): number => {
  const n = value == null || value === "" ? NaN : Number(value);
  if (!Number.isFinite(n)) throw new LineHoldFactsUnreadable();
  return n;
};

/** Batch ids in URL-sized chunks, paged so no row is lost at PostgREST's
 * row limit. Any error or non-array answer refuses (never reads as none). */
async function readChunked(
  client: any,
  table: string,
  columns: string,
  field: string,
  ids: string[],
  filter: (q: any) => any = (q) => q,
): Promise<any[]> {
  const rows: any[] = [];
  for (let start = 0; start < ids.length; start += 25) {
    for (let offset = 0;; offset += 1000) {
      const response = await filter(
        client.from(table).select(columns).in(
          field,
          ids.slice(start, start + 25),
        ),
      )
        .order(
          table === "feature_flags"
            ? "flag_name"
            : table === "v_job_commission"
            ? "job_id"
            : table === "trade_invoice_extra_rate_rules"
            ? "line_type"
            : "id",
        )
        .range(offset, offset + 999);
      if (response.error || !Array.isArray(response.data)) {
        throw new LineHoldFactsUnreadable();
      }
      rows.push(...response.data);
      if (response.data.length < 1000) break;
    }
  }
  return rows;
}

/** One job's work-order balance in cents: the order's agreed labour plus its
 * approved variations and amount changes, and what is already billed on the
 * job by the database's one sum (readWorkOrderBackedBilled), the same lines
 * the job amount guard counts. Shared by the send and my_hours. */
function workOrderBalanceCents(
  jobId: string,
  wo: { id: string; agreed_labour_ex: unknown } | undefined,
  variations: any[],
  changes: any[],
  billed: ReadonlyMap<string, number>,
): { agreed: number | null; allowedCents: number; billedCents: number } {
  const agreed = wo?.agreed_labour_ex == null ? null : numeric(wo.agreed_labour_ex);
  const added = variations.filter((v) =>
    v.job_id === jobId && v.work_order_id === wo?.id &&
    v.status === "approved"
  )
    .reduce((s, v) => s + cents(numeric(v.trade_allocation_ex ?? 0)), 0);
  const changed = changes.filter((c) => c.work_order_id === wo?.id).reduce(
    (s, c) => s + cents(numeric(c.delta_ex)),
    0,
  );
  if (!billed.has(jobId)) throw new LineHoldFactsUnreadable();
  const billedCents = cents(numeric(billed.get(jobId)));
  return {
    agreed,
    allowedCents: (agreed === null ? 0 : cents(agreed)) + added + changed,
    billedCents,
  };
}

const COMMISSION_FIGURES =
  "job_id,commission_id,budget_id,version,state,salesperson_user_id,rule_id,percent,expected_amount_ex_gst,claimed_ex_gst,remaining_ex_gst";

/** Batch all job/receipt ids once, in URL-sized chunks and paged so old billed
 * lines cannot disappear at PostgREST's row limit. No write occurs here.
 * Read only when the held-line send is on (trade_line_hold_v1). */
export async function readLineHoldFacts(
  client: any,
  userId: string,
  lines: readonly HoldLine[],
): Promise<LineHoldFacts> {
  try {
    const jobIds = [
      ...new Set(lines.map((l) => l.job_id).filter((id): id is string => !!id)),
    ];
    const receiptIds = [
      ...new Set(
        lines.map((l) => l.expense_receipt_id).filter((id): id is string =>
          !!id
        ),
      ),
    ];
    const commissionJobIds = [
      ...new Set(
        lines.filter((l) => l.job_id && key(l.line_type) === "commission")
          .map((l) => l.job_id as string),
      ),
    ];
    const typeIds = [
      ...new Set(
        lines.map((l) => l.not_job_work_type_id).filter((id): id is string =>
          !!id
        ),
      ),
    ];
    const read = (
      table: string,
      columns: string,
      field: string,
      ids: string[],
      filter?: (q: any) => any,
    ) => readChunked(client, table, columns, field, ids, filter);
    // jobs_pkey; users_pkey; uq_work_orders_job_current; job_budgets_version_unique;
    // uq_group_work_orders_job_work_order. No full scope/pricing blobs.
    const [
      users,
      jobs,
      orders,
      variations,
      commissions,
      receipts,
      types,
      rules,
      rates,
      budgets,
      groups,
      flags,
      capScope,
    ] = await Promise.all([
      read("users", "id,org_id,invoice_type", "id", [userId]),
      read("jobs", "id,org_id,job_number,type,metadata", "id", jobIds),
      read(
        "work_orders",
        "id,job_id,status,agreed_labour_ex",
        "job_id",
        jobIds,
        (q) => q.eq("kind", "job"),
      ),
      // idx_work_order_customer_variations_job and job_commissions_version_unique.
      read(
        "work_order_customer_variations",
        "id,job_id,work_order_id,status,trade_allocation_ex",
        "job_id",
        jobIds,
      ),
      // Commission: figures are read only for the sender's own records, and
      // only for jobs this send claims commission on. Every other record is
      // read as its job id alone: another salesperson's id and figures are
      // never fetched (a record that is not the sender's is skipped not_yours).
      read(
        "v_job_commission",
        COMMISSION_FIGURES,
        "job_id",
        commissionJobIds,
        (q) => q.eq("salesperson_user_id", userId),
      ),
      // expense_receipts_pkey and not_job_work_types_pkey.
      read("expense_receipts", "id,status,submitted_by", "id", receiptIds),
      read("not_job_work_types", "id,label,org_id,active", "id", typeIds),
      // Small configuration table, intentionally all rate-rule keys.
      (async () => {
        const r = await client.from("trade_invoice_extra_rate_rules").select(
          "line_type,max_unit_rate_ex",
        );
        if (r.error || !Array.isArray(r.data)) {
          throw new LineHoldFactsUnreadable();
        }
        return r.data;
      })(),
      // idx_trade_rates_user: only this sender's dated rates.
      read(
        "trade_rates",
        "id,hourly_rate,effective_from,effective_to",
        "user_id",
        [userId],
      ),
      read(
        "job_budgets",
        "id,job_id,version,pay:budget->labour->>pay",
        "job_id",
        jobIds,
      ),
      read("group_work_orders", "id,job_id,status", "job_id", jobIds),
      read("feature_flags", "flag_name,enabled", "flag_name", [
        JOB_LABOUR_BUDGET_FLAG,
      ]),
      readWorkOrderCapScope(client, jobIds),
    ]);
    if (users.length !== 1) throw new LineHoldFactsUnreadable();
    // Which of those jobs carry a record at all: job id only, no salesperson
    // and no figure (job_commissions_version_unique via the view).
    const ownCommissionJobs = new Set(
      commissions.filter((c) => c.salesperson_user_id === userId).map((c) =>
        String(c.job_id)
      ),
    );
    const otherCommissionJobs = (await read(
      "v_job_commission",
      "job_id",
      "job_id",
      commissionJobIds.filter((id) => !ownCommissionJobs.has(id)),
    )).map((c) => String(c.job_id));
    const facts: LineHoldFacts = {
      userId,
      jobs: {},
      receipts: {},
      notJobTypes: {},
      commissions: {},
      rateRules: {
        ok: true,
        rules: rules.map((r: any) => ({
          line_type: key(r.line_type),
          max_unit_rate_ex: numeric(r.max_unit_rate_ex),
        })),
      },
      tradeRates: rates.map((r) => ({
        ...r,
        hourly_rate: numeric(r.hourly_rate),
      })),
      split_group_ids: lines.map(() => crypto.randomUUID()),
    };
    const ownJobs = jobs.filter((row) =>
      !row.org_id || row.org_id === users[0].org_id
    );
    // work_order_amount_changes_wo_idx, ids bounded to this send. Billed:
    // the database's one sum, only for jobs read above (FU49 item 8).
    const [changes, billed] = await Promise.all([
      read(
        "work_order_amount_changes",
        "id,work_order_id,delta_ex",
        "work_order_id",
        orders.map((o) => o.id),
      ),
      readWorkOrderBackedBilled(client, ownJobs.map((row) => row.id)),
    ]);
    for (const row of ownJobs) {
      const wo = orders.find((o) =>
        o.job_id === row.id && o.status === "approved"
      ) ?? orders.find((o) => o.job_id === row.id && o.status === "draft");
      const balance = workOrderBalanceCents(row.id, wo, variations, changes, billed);
      const agreed = balance.agreed;
      const budget = budgets.filter((b) =>
        b.job_id === row.id
      ).sort((a, b) => b.version - a.version)[0];
      const family = row.metadata?.ses_family ??
        row.metadata?.makesafe_job_family;
      const vertical = row.type === "repair" || family === "repair"
        ? "repair"
        : row.type;
      const mode = decideTradeInvoiceMode({
        hasLiveGroupWorkOrder: groups.some((g) =>
          g.job_id === row.id && g.status !== "void"
        ),
        tradeInvoiceType: users[0].invoice_type,
        jobVertical: vertical,
        hourlyCapped: flags.some((f) =>
          f.flag_name === JOB_LABOUR_BUDGET_FLAG && f.enabled === true
        ) &&
          budgetLabourPay({ labour: { pay: budget?.pay } }) === "hourly_capped",
        restorationWorkOrder: isRestorationCard(row) &&
          wo?.status === "approved" && agreed !== null,
      });
      facts.jobs[row.id] = {
        job_number: row.job_number ?? null,
        workOrder: wo
          ? { id: wo.id, status: wo.status, agreed_ex: agreed }
          : null,
        allowed_ex: balance.allowedCents / 100,
        backed_billed_ex: balance.billedCents / 100,
        hourly: mode.invoice_mode === "hourly",
        cap_in_scope: capScope.get(row.id) === true,
        off_crew_by_week: {},
      };
    }
    for (const r of receipts) {
      facts.receipts[r.id] = {
        approved: r.submitted_by === userId && r.status === "approved",
      };
    }
    for (const t of types) {
      if (t.active && t.org_id === users[0].org_id) {
        facts.notJobTypes[t.id] = t.label;
      }
    }
    for (const jobId of otherCommissionJobs) {
      facts.commissions[jobId] = {
        job_id: jobId,
        commission_id: "",
        budget_id: "",
        version: 0,
        state: "named",
        salesperson_user_id: null,
        rule_id: null,
        percent: null,
        expected_amount_ex_gst: null,
        claimed_ex_gst: 0,
        remaining_ex_gst: null,
      };
    }
    for (const c of commissions) {
      if (c.salesperson_user_id !== userId) continue;
      facts.commissions[c.job_id] = {
        ...c,
        expected_amount_ex_gst: c.expected_amount_ex_gst == null
          ? null
          : numeric(c.expected_amount_ex_gst),
        remaining_ex_gst: c.remaining_ex_gst == null
          ? null
          : numeric(c.remaining_ex_gst),
        claimed_ex_gst: numeric(c.claimed_ex_gst),
      };
    }
    const pairs = [
      ...new Set(
        lines.filter((l) => l.job_id && countsAgainstWorkOrder(l.line_type))
          .map((l) => JSON.stringify([l.job_id, week(l)])),
      ),
    ].map((s) => JSON.parse(s) as [string, string]);
    // RPC reads the existing (job_id,user_id,scheduled_date) unique index.
    // Eight at a time, once per distinct job/week, never per invoice line.
    for (let start = 0; start < pairs.length; start += 8) {
      await Promise.all(
        pairs.slice(start, start + 8).map(async ([id, startDay]) => {
          // A counted line with no week and no work date cannot be checked
          // against the crew. It is held not_on_crew (with the reason the
          // other rules give as fallback), never thrown (director 18 Nov).
          if (!startDay) {
            if (facts.jobs[id]) facts.jobs[id].off_crew_by_week![""] = true;
            return;
          }
          const result = await client.rpc("trade_is_off_job_crew", {
            p_user_id: userId,
            p_job_id: id,
            p_week_start: startDay,
          });
          if (result.error || typeof result.data !== "boolean") {
            throw new LineHoldFactsUnreadable();
          }
          if (facts.jobs[id]) {
            facts.jobs[id].off_crew_by_week![startDay] = result.data;
          }
        }),
      );
    }
    return facts;
  } catch {
    throw new LineHoldFactsUnreadable();
  }
}

/** my_hours: what is left on each job's approved work order, and nothing
 * else (null: no approved amount, or the job is outside the cap's scope, which
 * holds nothing). A balance-only read: no commission, no salesperson, no rate
 * and no receipt is fetched. Throws LineHoldFactsUnreadable on any failed
 * read; the caller says so, never 0. */
export async function readJobAmountsLeft(
  client: any,
  userId: string,
  jobIds: readonly string[],
): Promise<Record<string, number | null>> {
  return (await readJobAmountsState(client, userId, jobIds)).left;
}

/** readJobAmountsLeft plus, per job, whether it is under the cap
 * (work_order_cap_scope). A job outside it has left null and capped false. */
export async function readJobAmountsState(
  client: any,
  userId: string,
  jobIds: readonly string[],
): Promise<{
  left: Record<string, number | null>;
  capped: Record<string, boolean>;
}> {
  try {
    const ids = [...new Set(jobIds.filter((id) => !!id))];
    const out: Record<string, number | null> = {};
    const capped: Record<string, boolean> = {};
    if (ids.length === 0) return { left: out, capped };
    // users_pkey; jobs_pkey; uq_work_orders_job_current;
    // idx_work_order_customer_variations_job.
    const [users, jobs, orders, variations, scope] = await Promise.all([
      readChunked(client, "users", "id,org_id", "id", [userId]),
      readChunked(client, "jobs", "id,org_id", "id", ids),
      readChunked(
        client,
        "work_orders",
        "id,job_id,status,agreed_labour_ex",
        "job_id",
        ids,
        (q) => q.eq("kind", "job").eq("status", "approved"),
      ),
      readChunked(
        client,
        "work_order_customer_variations",
        "id,job_id,work_order_id,status,trade_allocation_ex",
        "job_id",
        ids,
      ),
      readWorkOrderCapScope(client, ids),
    ]);
    if (users.length !== 1) throw new LineHoldFactsUnreadable();
    const ownJobs = jobs.filter((row) =>
      !row.org_id || row.org_id === users[0].org_id
    );
    // work_order_amount_changes_wo_idx, ids bounded to these orders. Billed:
    // the database's one sum, the same as the send (FU49 item 8).
    const [changes, billed] = await Promise.all([
      readChunked(
        client,
        "work_order_amount_changes",
        "id,work_order_id,delta_ex",
        "work_order_id",
        orders.map((o) => o.id),
      ),
      readWorkOrderBackedBilled(client, ownJobs.map((row) => row.id)),
    ]);
    for (const row of ownJobs) {
      const wo = orders.find((o) =>
        o.job_id === row.id && o.status === "approved"
      );
      const balance = workOrderBalanceCents(row.id, wo, variations, changes, billed);
      capped[row.id] = scope.get(row.id) === true;
      out[row.id] = !capped[row.id] || !wo || balance.agreed === null
        ? null
        : (balance.allowedCents - balance.billedCents) / 100;
    }
    return { left: out, capped };
  } catch {
    throw new LineHoldFactsUnreadable();
  }
}
