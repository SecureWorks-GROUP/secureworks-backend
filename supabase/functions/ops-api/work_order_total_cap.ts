// No trade bills more than a work order allows, in total (owner, 15 Nov 2026:
// "no one should be able to order more than the work order that's been set by
// the office ... they shouldn't be able to, in total, charge more than what
// the work order has allowed").
//
// workOrderAmountRefusal (trade_invoice_mode.ts) already makes each invoice's
// work-order line carry exactly the agreed amount. It looks at one invoice.
// This rule looks at the job: the labour already billed on it by every trade
// (every live invoice, the lead's and the crew's), plus the labour on the
// invoice being sent, may not go over the work order's agreed labour plus its
// approved customer variations. Over it, nothing is saved (409).
//
// - Jobs billed as a work order with an approved job work order carrying its
//   agreed labour (work_order_agreed_ex on the job's mode) are capped at it.
// - Ruling 17c (16 Nov 2026): a job billed hourly because its job budget pays
//   the crew by the hour up to a sealed maximum (invoice_mode_reason
//   hourly_capped, job_labour_cap.ts, while job_labour_budget_v1 is on) is
//   capped by this same rule, counted the same way, at its hourly maximum:
//   the budget's labour (sealed hours times the sealed rate, plus any crew
//   option the customer took) plus the approver's raises. A trade's own rate
//   on a job never raises it. Other hourly jobs, group work orders and jobs
//   with no agreed amount keep their own rules; the pay-run check stops a
//   work order with no agreed amount.
// - Every line on the job counts (hours, the work order line, deductions,
//   travel, materials, any type a client sends) except commission
//   (NOT_AGAINST_WORK_ORDER_LINE_TYPES). Commission has its own cap
//   (job_commission.ts).
// - Billed is JOB_WORK_ORDER_BILLED_INVOICE_STATUSES: a draft, a rejected or a
//   voided invoice holds nothing.
// - Only the office can raise the figure, through an approved customer
//   variation or a new work order.
//
// Refusals carry the job and the most this invoice may still bill on it. They
// never name another trade or their figure (a trade who knows the agreed
// amount can still work out the total others billed from the remainder).
//
// Known limits: the read and the save are not one transaction, so two
// invoices sent at the same moment can both pass (the commission cap has a
// database guard; this one does not yet). A job billed hourly with no sealed
// maximum is not capped even when it has a job work order.
// deno-lint-ignore-file no-explicit-any

import {
  JOB_WORK_ORDER_BILLED_INVOICE_STATUSES,
  readCustomerVariations,
  readJobTradeLines,
} from "./job_work_orders.ts";

/**
 * The one line type that never counts against a work order: commission, which
 * has its own cap (job_commission.ts). Every other line on a capped job
 * counts, whatever its type: labour, the work order line, any deduction
 * (negative), travel, materials, and any type the client sends ("decking",
 * "other", "install" ...). The line type is the client's word, so a type
 * left out would be a label that bills around the work order. Travel and
 * materials past the work order are an office variation (on 13 Nov 2026 a
 * work order invoice carried a travel line equal to the work order amount on
 * two jobs, SW-INV-SL-261113-016; no materials line was billed in the 120
 * days before).
 */
export const NOT_AGAINST_WORK_ORDER_LINE_TYPES: ReadonlySet<string> = new Set([
  "commission",
]);

export function countsAgainstWorkOrder(lineType: unknown): boolean {
  return !NOT_AGAINST_WORK_ORDER_LINE_TYPES.has(
    String(lineType ?? "").trim().toLowerCase(),
  );
}

export type WorkOrderCapJob = {
  jobId: string;
  /** The job number, for the message. */
  ref: string;
  /** Agreed labour plus approved customer variations, ex GST; on an hourly
   *  job, its hourly maximum plus the approver's raises. */
  allowedEx: number;
  /** Set on a job paid hourly up to a sealed maximum (ruling 17c). */
  limit?: "hourly_maximum";
};

export type WorkOrderTotalCapRefusal = {
  code: "work_order_total_over_agreed";
  message: string;
  jobs: Array<{
    job: string;
    job_id: string;
    most_this_invoice_ex: number;
    /** Only on a job paid hourly up to a sealed maximum. */
    limit?: "hourly_maximum";
    hourly_maximum_ex?: number;
  }>;
};

const cents = (v: number) => Math.round(v * 100);
const money = (v: number) => Math.round(v * 100) / 100;

function dollars(value: number): string {
  const fixed = money(value).toFixed(2);
  const [whole, part] = fixed.split(".");
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${part}`;
}

/**
 * Pure. null when every capped job stays within what its work order allows
 * once this invoice's labour is added to what is already billed on it.
 */
export function workOrderTotalCapRefusal(input: {
  jobs: readonly WorkOrderCapJob[];
  /** Labour already billed on each job by every live invoice, ex GST. */
  billedEx: ReadonlyMap<string, number>;
  /** Labour on the invoice being sent, per job, ex GST. */
  incomingEx: ReadonlyMap<string, number>;
  /** Check a job even when its incoming is 0 or less (a raised deduction). */
  force?: boolean;
}): WorkOrderTotalCapRefusal | null {
  const over: WorkOrderTotalCapRefusal["jobs"] = [];
  for (const job of input.jobs) {
    const incoming = input.incomingEx.get(job.jobId) ?? 0;
    if (!input.incomingEx.has(job.jobId)) continue;
    if (!input.force && cents(incoming) <= 0) continue;
    const billed = input.billedEx.get(job.jobId) ?? 0;
    if (cents(billed) + cents(incoming) <= cents(job.allowedEx)) continue;
    over.push({
      job: job.ref,
      job_id: job.jobId,
      most_this_invoice_ex: Math.max(0, money(job.allowedEx - billed)),
      ...(job.limit === "hourly_maximum"
        ? {
          limit: "hourly_maximum" as const,
          hourly_maximum_ex: money(job.allowedEx),
        }
        : {}),
    });
  }
  if (over.length === 0) return null;
  const message = over.map((j) =>
    j.limit === "hourly_maximum"
      ? j.most_this_invoice_ex > 0
        ? `Job ${j.job}: it is paid by the hour up to an hourly maximum of ${
          dollars(j.hourly_maximum_ex ?? 0)
        } in labour, and this invoice can bill at most ${
          dollars(j.most_this_invoice_ex)
        } more on it. A higher hourly rate does not raise the maximum. Ask the office if it needs raising.`
        : `Job ${j.job}: its hourly maximum of ${
          dollars(j.hourly_maximum_ex ?? 0)
        } in labour has been billed in full. A higher hourly rate does not raise it. Ask the office if it needs raising.`
      : j.most_this_invoice_ex > 0
      ? `Job ${j.job}: this invoice can bill at most ${
        dollars(j.most_this_invoice_ex)
      } on its work order. If someone else on the job billed their part, list them as crew on the work order. Ask the office if the work order needs changing.`
      : `Job ${j.job}: its work order has been billed in full. Ask the office if it needs changing.`
  ).join(" ");
  return { code: "work_order_total_over_agreed", message, jobs: over };
}

/** Pure. This invoice's labour per job, from the lines about to be saved. */
export function incomingLabourByJob(
  lines: ReadonlyArray<
    { job_id?: unknown; line_type?: unknown; line_total_ex?: unknown }
  >,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of lines) {
    const jobId = String(line?.job_id ?? "").trim();
    if (!jobId || !countsAgainstWorkOrder(line?.line_type)) continue;
    const amount = Number(line?.line_total_ex);
    if (!Number.isFinite(amount)) continue;
    out.set(jobId, money((out.get(jobId) ?? 0) + amount));
  }
  return out;
}

export class WorkOrderTotalCapReadError extends Error {
  constructor() {
    super("Could not read what is already billed on these work orders");
  }
}

/** Pure. What counts as already billed on each job: every line on a billed
 *  invoice except commission, less the lines a change replaces. */
function billedFromLines(
  lines: Awaited<ReturnType<typeof readJobTradeLines>>,
  excludeLineIds: readonly string[] = [],
): Map<string, number> {
  const excluded = new Set(excludeLineIds.map(String));
  const billedEx = new Map<string, number>();
  for (const line of lines) {
    if (!JOB_WORK_ORDER_BILLED_INVOICE_STATUSES.has(line.invoice_status)) {
      continue;
    }
    if (!countsAgainstWorkOrder(line.line_type)) continue;
    if (excluded.has(String(line.trade_invoice_line_id))) continue;
    billedEx.set(
      line.job_id,
      money((billedEx.get(line.job_id) ?? 0) + line.amount_ex),
    );
  }
  return billedEx;
}

/**
 * What is already billed on each job, by the one count every cap uses
 * (billedFromLines). Throws WorkOrderTotalCapReadError on a failed read.
 */
export async function readBilledOnJobs(
  client: any,
  jobIds: readonly string[],
  opts: { excludeLineIds?: readonly string[] } = {},
): Promise<Map<string, number>> {
  const ids = [...new Set(jobIds.map(String).filter(Boolean))];
  if (ids.length === 0) return new Map();
  let lines: Awaited<ReturnType<typeof readJobTradeLines>>;
  try {
    lines = await readJobTradeLines(client, ids);
  } catch {
    throw new WorkOrderTotalCapReadError();
  }
  return billedFromLines(lines, opts.excludeLineIds);
}

/**
 * Reads what each capped job allows (agreed plus approved customer variations
 * on that work order) and what is already billed on it. Throws
 * WorkOrderTotalCapReadError on any failed read: an unreadable job is never
 * read as "nothing billed".
 */
export async function readWorkOrderCapFacts(
  client: any,
  jobs: ReadonlyArray<
    { jobId: string; ref: string; agreedEx: number; workOrderId: string }
  >,
  opts: { excludeLineIds?: readonly string[] } = {},
): Promise<{ jobs: WorkOrderCapJob[]; billedEx: Map<string, number> }> {
  if (jobs.length === 0) return { jobs: [], billedEx: new Map() };
  const ids = jobs.map((j) => j.jobId);
  let lines: Awaited<ReturnType<typeof readJobTradeLines>>;
  let variations: any[];
  try {
    [lines, variations] = await Promise.all([
      readJobTradeLines(client, ids),
      readCustomerVariations(client, ids),
    ]);
  } catch {
    throw new WorkOrderTotalCapReadError();
  }
  const billedEx = billedFromLines(lines, opts.excludeLineIds);
  const capJobs = jobs.map((j) => {
    const added = variations
      .filter((v) =>
        String(v?.job_id) === j.jobId &&
        String(v?.work_order_id) === j.workOrderId &&
        String(v?.status) === "approved"
      )
      .reduce((s, v) => s + (Number(v?.trade_allocation_ex) || 0), 0);
    return { jobId: j.jobId, ref: j.ref, allowedEx: money(j.agreedEx + added) };
  });
  return { jobs: capJobs, billedEx };
}

/** How a job is billed, as loadTradeInvoiceJobModes answers it. */
export type WorkOrderCapMode = {
  job_id: string;
  invoice_mode: string;
  /** hourly_capped: paid by the hour up to a sealed maximum (ruling 17c). */
  invoice_mode_reason?: string | null;
  work_order_agreed_ex: number | null;
  job_work_order_id: string | null;
};

/** A job paid by the hour up to the maximum its job budget seals. */
export function isHourlyCappedMode(m: WorkOrderCapMode): boolean {
  return m.invoice_mode === "hourly" &&
    m.invoice_mode_reason === "hourly_capped";
}

/** Pure. A whole, non-negative amount in dollars and cents, or null. */
function capLimit(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? money(value)
    : null;
}

/**
 * The whole check, shared by every door that saves or changes a trade line
 * (generate_trade_invoice, submit_work_order_invoice, a lead's adjust in
 * review_crew_charge). `lines` are the lines about to be saved or the new
 * amount of a changed line; `excludeLineIds` are saved lines whose old amount
 * the change replaces. loadModes and jobRefs throw WorkOrderTotalCapReadError
 * on a failed read. null: nothing goes over.
 */
export async function checkWorkOrderTotalCap(client: any, input: {
  lines: ReadonlyArray<
    { job_id?: unknown; line_type?: unknown; line_total_ex?: unknown }
  >;
  loadModes: (jobIds: string[]) => Promise<readonly WorkOrderCapMode[]>;
  jobRefs: (jobIds: string[]) => Promise<ReadonlyMap<string, string>>;
  /**
   * Ruling 17c: each hourly capped job's limit (its hourly maximum plus the
   * approver's raises, ex GST). Throws WorkOrderTotalCapReadError on a failed
   * or unreadable read. Without it an hourly capped job is refused as
   * unreadable, never let through.
   */
  loadHourlyLimits?: (
    jobIds: string[],
  ) => Promise<ReadonlyMap<string, number>>;
  excludeLineIds?: readonly string[];
  /**
   * A changed line that goes up: check its job even when the new amount is
   * 0 or less (a deduction raised towards 0 lifts the job's total).
   */
  force?: boolean;
}): Promise<WorkOrderTotalCapRefusal | null> {
  const incoming = incomingLabourByJob(input.lines);
  const jobIds = [...incoming].filter(([, ex]) => input.force || cents(ex) > 0)
    .map(([id]) => id);
  if (jobIds.length === 0) return null;
  const modes = await input.loadModes(jobIds);
  const capped = modes.filter((m) =>
    m.invoice_mode === "work_order" && m.work_order_agreed_ex != null &&
    !!m.job_work_order_id
  );
  const hourly = modes.filter(isHourlyCappedMode);
  if (capped.length === 0 && hourly.length === 0) return null;
  // An hourly limit that cannot be read is never read as no limit.
  let limits: ReadonlyMap<string, number> = new Map();
  if (hourly.length > 0) {
    if (!input.loadHourlyLimits) throw new WorkOrderTotalCapReadError();
    limits = await input.loadHourlyLimits(hourly.map((m) => m.job_id));
    for (const m of hourly) {
      if (capLimit(limits.get(m.job_id)) === null) {
        throw new WorkOrderTotalCapReadError();
      }
    }
  }
  const refs = await input.jobRefs(
    [...capped, ...hourly].map((m) => m.job_id),
  );
  const facts = await readWorkOrderCapFacts(
    client,
    capped.map((m) => ({
      jobId: m.job_id,
      ref: refs.get(m.job_id) || m.job_id,
      agreedEx: Number(m.work_order_agreed_ex),
      workOrderId: String(m.job_work_order_id),
    })),
    { excludeLineIds: input.excludeLineIds },
  );
  const hourlyBilled = await readBilledOnJobs(
    client,
    hourly.map((m) => m.job_id),
    { excludeLineIds: input.excludeLineIds },
  );
  const billedEx = new Map([...facts.billedEx, ...hourlyBilled]);
  return workOrderTotalCapRefusal({
    jobs: [
      ...facts.jobs,
      ...hourly.map((m) => ({
        jobId: m.job_id,
        ref: refs.get(m.job_id) || m.job_id,
        allowedEx: capLimit(limits.get(m.job_id)) as number,
        limit: "hourly_maximum" as const,
      })),
    ],
    billedEx,
    incomingEx: incoming,
    force: input.force,
  });
}

/** The cap as the office list shows it, for one approved job work order. */
export type WorkOrderCapSummary = {
  allowed_ex: number;
  billed_ex: number;
  remaining_ex: number;
  billed_in_full: boolean;
  over: boolean;
  /** On a job paid hourly up to a sealed maximum: allowed_ex is that
   *  maximum plus raises, which is what the doors refuse by (ruling 17c). */
  limit?: "hourly_maximum";
};

/**
 * Adds `cap` to every approved job work order with its agreed labour in a
 * list_work_orders kind=job answer, read by the same rule the invoice doors
 * refuse by (readWorkOrderCapFacts). Other rows get `cap: null`. A failed read
 * never reads as nothing billed: every row gets `cap: null` and the answer
 * says `cap_read: "failed"`. Reads only; it changes nothing.
 *
 * `hourlyLimits` (ruling 17c) answers the jobs among those given that are
 * paid hourly up to a sealed maximum, with that limit; such a row shows the
 * limit the doors refuse by, not its work order's agreed labour.
 */
export async function withWorkOrderCaps<
  T extends { work_orders: any[] },
>(client: any, listing: T, opts: {
  hourlyLimits?: (jobIds: string[]) => Promise<ReadonlyMap<string, number>>;
} = {}): Promise<
  T & { cap_read: "ok" | "failed"; work_orders: any[] }
> {
  const rows = Array.isArray(listing?.work_orders) ? listing.work_orders : [];
  const capped = rows.filter((r) =>
    String(r?.status) === "approved" && r?.agreed_labour_ex != null &&
    r?.job_id && r?.id
  );
  let summaries = new Map<string, WorkOrderCapSummary>();
  let read: "ok" | "failed" = "ok";
  try {
    const facts = await readWorkOrderCapFacts(
      client,
      capped.map((r) => ({
        jobId: String(r.job_id),
        ref: String(r.job_number || r.job_id),
        agreedEx: Number(r.agreed_labour_ex) || 0,
        workOrderId: String(r.id),
      })),
    );
    const allowedByJob = new Map(facts.jobs.map((j) => [j.jobId, j.allowedEx]));
    const hourly = opts.hourlyLimits && capped.length > 0
      ? await opts.hourlyLimits([
        ...new Set<string>(capped.map((r) => String(r.job_id))),
      ])
      : new Map<string, number>();
    for (const [, limit] of hourly) {
      if (capLimit(limit) === null) throw new WorkOrderTotalCapReadError();
    }
    summaries = new Map(capped.map((r) => {
      const jobId = String(r.job_id);
      const hourlyLimit = hourly.has(jobId)
        ? capLimit(hourly.get(jobId))
        : null;
      const allowed = hourlyLimit ?? allowedByJob.get(jobId) ?? 0;
      const billed = facts.billedEx.get(jobId) ?? 0;
      return [String(r.id), {
        allowed_ex: allowed,
        billed_ex: billed,
        remaining_ex: (cents(allowed) - cents(billed)) / 100,
        billed_in_full: cents(billed) >= cents(allowed),
        over: cents(billed) > cents(allowed),
        ...(hourlyLimit !== null ? { limit: "hourly_maximum" as const } : {}),
      }];
    }));
  } catch {
    read = "failed";
    summaries = new Map();
  }
  return {
    ...listing,
    cap_read: read,
    work_orders: rows.map((r) => ({
      ...r,
      cap: read === "ok" ? summaries.get(String(r?.id)) ?? null : null,
    })),
  };
}
