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
// - Only jobs billed as a work order with an approved job work order carrying
//   its agreed labour (work_order_agreed_ex on the job's mode) are capped.
//   Hourly jobs, group work orders and jobs with no agreed amount keep their
//   own rules; the pay-run check stops a work order with no agreed amount.
// - Labour is the labour cost lane (v_trade_charge_resolved): hours, work
//   order lines and crew deductions on the job. Materials, travel and
//   commission are not labour. Commission has its own cap (job_commission.ts).
// - Billed is JOB_WORK_ORDER_BILLED_INVOICE_STATUSES: a draft, a rejected or a
//   voided invoice holds nothing.
// - Only the office can raise the figure, through an approved customer
//   variation or a new work order.
//
// Refusals carry the job and the most this invoice may still bill on it. They
// never say what anyone else billed.
// deno-lint-ignore-file no-explicit-any

import {
  JOB_WORK_ORDER_BILLED_INVOICE_STATUSES,
  readCustomerVariations,
  readJobLabourLines,
} from "./job_work_orders.ts";

/** Line types in the labour lane of v_trade_charge_resolved (20261015093000). */
export const WORK_ORDER_LABOUR_LINE_TYPES: ReadonlySet<string> = new Set([
  "labour",
  "fencing",
  "patio",
  "make safe",
  "general labour",
  "crew_work_order_deduction",
  "labour_deduction",
  "work order",
  "work_order",
]);

export function isWorkOrderLabourLineType(lineType: unknown): boolean {
  return WORK_ORDER_LABOUR_LINE_TYPES.has(
    String(lineType ?? "").trim().toLowerCase(),
  );
}

export type WorkOrderCapJob = {
  jobId: string;
  /** The job number, for the message. */
  ref: string;
  /** Agreed labour plus approved customer variations, ex GST. */
  allowedEx: number;
};

export type WorkOrderTotalCapRefusal = {
  code: "work_order_total_over_agreed";
  message: string;
  jobs: Array<{ job: string; job_id: string; most_this_invoice_ex: number }>;
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
}): WorkOrderTotalCapRefusal | null {
  const over: WorkOrderTotalCapRefusal["jobs"] = [];
  for (const job of input.jobs) {
    const incoming = input.incomingEx.get(job.jobId) ?? 0;
    if (cents(incoming) <= 0) continue;
    const billed = input.billedEx.get(job.jobId) ?? 0;
    if (cents(billed) + cents(incoming) <= cents(job.allowedEx)) continue;
    over.push({
      job: job.ref,
      job_id: job.jobId,
      most_this_invoice_ex: Math.max(0, money(job.allowedEx - billed)),
    });
  }
  if (over.length === 0) return null;
  const message = over.map((j) =>
    j.most_this_invoice_ex > 0
      ? `Job ${j.job}: this invoice can bill at most ${
        dollars(j.most_this_invoice_ex)
      } of labour on its work order. If someone else on the job billed their part, list them as crew on the work order. Ask the office if the work order needs changing.`
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
    if (!jobId || !isWorkOrderLabourLineType(line?.line_type)) continue;
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
): Promise<{ jobs: WorkOrderCapJob[]; billedEx: Map<string, number> }> {
  if (jobs.length === 0) return { jobs: [], billedEx: new Map() };
  const ids = jobs.map((j) => j.jobId);
  let lines: Awaited<ReturnType<typeof readJobLabourLines>>;
  let variations: any[];
  try {
    [lines, variations] = await Promise.all([
      readJobLabourLines(client, ids),
      readCustomerVariations(client, ids),
    ]);
  } catch {
    throw new WorkOrderTotalCapReadError();
  }
  const billedEx = new Map<string, number>();
  for (const line of lines) {
    if (!JOB_WORK_ORDER_BILLED_INVOICE_STATUSES.has(line.invoice_status)) {
      continue;
    }
    billedEx.set(
      line.job_id,
      money((billedEx.get(line.job_id) ?? 0) + line.amount_ex),
    );
  }
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
