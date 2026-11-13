// Who may bill a job on an ordinary extra line of their own trade invoice.
//
// generate_trade_invoice's extra_items lane takes lines a trade typed or
// searched in, each naming a job. Owning the invoice is not permission to bill
// that job. Before any extra line is priced or written, every job one names
// must be found inside the caller's company (index.ts resolves it there) and
// must pass ONE of the rules below. A line that passes none refuses the whole
// submission, so nothing is written.
//
// This lane only. The weekly work-order lane, group shares, the trade's own
// job cards (manual_assignments) and the legacy clocked lane keep their own
// checks. A line that names no job (an adjustment) is not a job claim and is
// not checked here.
//
// Commission (Marnin, 11 Nov 2026) is an extra line a trade may add only on a
// job they created, a job in a division they manage, or with the office's
// invoice-any-job grant. Being booked on the job does not allow commission.
// tradeMayClaimCommission is the read the trade app is given
// (trade_invoice_mode.ts); it runs this same list.
//
// Ruling 17 step 2: a job whose accepted budget stored a commission record
// (job_commissions) takes a commission line from its named salesperson only,
// whoever created or manages the job; the amount is held by job_commission.ts
// and the database. A job with no record keeps the rules below as they were.
//
// The rules are the owner's to change: edit this list, with a test.
// deno-lint-ignore-file no-explicit-any

import { readInvoiceAnyJobPermission } from "./trade_invoice_job_picker.ts";

export type ExtraJobBillingTrade = {
  id: string;
  orgId: string;
  managedVerticals: string[];
  isMakesafeManager: boolean;
  invoiceAnyJob: boolean;
};

export type ExtraJobBillingJob = {
  id: string;
  createdBy: string | null;
  vertical: string;
  bookedOn: boolean;
  // The job's commission record, when its accepted budget stored one: the
  // salesperson it names (null: nobody may claim). Absent: no record.
  commission?: { salespersonUserId: string | null } | null;
};

// A commission line on a job with a commission record: decided by the record
// alone (the named salesperson), never by the rules after it.
const recordDecidesCommission = (c: ExtraJobBillingCase) =>
  isCommissionLine(c.lineType) && !!c.job.commission;

export type ExtraJobBillingCase = {
  lineType: string;
  job: ExtraJobBillingJob;
  trade: ExtraJobBillingTrade;
};

export const EXTRA_JOB_BILLING_RULES: ReadonlyArray<{
  name: string;
  allows: (c: ExtraJobBillingCase) => boolean;
}> = [
  // (0) A commission line on a job with a commission record, from the
  //     salesperson the record names.
  {
    name: "commission_named_salesperson",
    allows: (c) =>
      recordDecidesCommission(c) && !!c.job.commission?.salespersonUserId &&
      c.job.commission.salespersonUserId === c.trade.id,
  },
  // (a) The trade has a live assignment on the job (not cancelled, not a
  //     ghost watcher row). Any line but commission.
  {
    name: "booked_on_job",
    allows: (c) => c.job.bookedOn && !isCommissionLine(c.lineType),
  },
  // (b) A commission line on a job the trade created.
  {
    name: "commission_on_job_they_created",
    allows: (c) =>
      isCommissionLine(c.lineType) && !recordDecidesCommission(c) &&
      !!c.job.createdBy && c.job.createdBy === c.trade.id,
  },
  // (c) The job is in a division the trade manages, or the trade is a
  //     make-safe manager and the job is a make-safe.
  {
    name: "manages_job_division",
    allows: (c) =>
      !recordDecidesCommission(c) &&
      ((!!c.job.vertical && c.trade.managedVerticals.includes(c.job.vertical)) ||
        (c.trade.isMakesafeManager && c.job.vertical === "makesafe")),
  },
  // (d) The office granted this trade invoice-any-job (literal true only).
  {
    name: "invoice_any_job_grant",
    allows: (c) => !recordDecidesCommission(c) && c.trade.invoiceAnyJob,
  },
];

export function isCommissionLine(lineType: string): boolean {
  return String(lineType || "").trim().toLowerCase() === "commission";
}

// The commission lines of an invoice, ex GST: what carries no super (Marnin,
// 12 Nov 2026). Reads each line's saved line_type through isCommissionLine,
// so a saved line and the line about to be saved are read the same way.
export function commissionLinesTotalEx(
  lines: ReadonlyArray<{ line_type?: unknown; line_total_ex?: unknown }>,
): number {
  const cents = (lines || []).reduce((sum, line) => {
    if (!isCommissionLine(String(line?.line_type ?? ""))) return sum;
    const amount = Number(line?.line_total_ex ?? 0);
    return Number.isFinite(amount) ? sum + Math.round(amount * 100) : sum;
  }, 0);
  return cents / 100;
}

export function extraJobBillingRule(c: ExtraJobBillingCase): string | null {
  return EXTRA_JOB_BILLING_RULES.find((rule) => rule.allows(c))?.name ?? null;
}

// May this trade add a commission line on this job? The same rule list, asked
// for a commission line; booking plays no part.
export function tradeMayClaimCommission(input: {
  job: Omit<ExtraJobBillingJob, "bookedOn">;
  trade: Omit<ExtraJobBillingTrade, "isMakesafeManager">;
}): boolean {
  return extraJobBillingRule({
    lineType: "commission",
    job: { ...input.job, bookedOn: false },
    trade: {
      ...input.trade,
      isMakesafeManager: input.trade.managedVerticals.includes("makesafe"),
    },
  }) !== null;
}

// The line's type, decided once. The same value is checked here, read by the
// pricing checks and saved as trade_invoice_lines.line_type. Only `type`
// counts (a client `line_type` is never saved, so it never grants anything).
export function extraLineType(item: any): string {
  const type = item?.type;
  return (typeof type === "string" ? type.trim().toLowerCase() : "") || "other";
}

function trimmedRef(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

// A client extra line with its type and job references trimmed once, so the
// check, the job lookup, the attribution and the saved line all read the same
// values. A blank or whitespace reference is no reference: an ordinary line
// with none is then refused by the existing every-line-needs-a-job rule, and
// a genuine adjustment keeps its jobless exception.
export function normaliseExtraItem(item: any): any {
  if (!item || typeof item !== "object") return item;
  return {
    ...item,
    type: typeof item.type === "string" ? item.type.trim() : item.type,
    job_id: trimmedRef(item.job_id),
    job_number: trimmedRef(item.job_number),
  };
}

export type ExtraJobBillingRefusalCode =
  | "extra_job_not_found"
  | "extra_job_not_allowed"
  | "commission_not_allowed"
  | "commission_not_salesperson";

export class ExtraJobBillingRefusal extends Error {
  code: ExtraJobBillingRefusalCode;
  // Jobs refused because the trade is not on them (adding themselves helps).
  jobs: string[];
  // Jobs whose commission line was refused (adding themselves does not help).
  commissionJobs: string[];
  constructor(
    code: ExtraJobBillingRefusalCode,
    jobs: string[],
    message: string,
    commissionJobs: string[] = [],
  ) {
    super(message);
    this.code = code;
    this.jobs = jobs;
    this.commissionJobs = commissionJobs;
  }
}

function jobList(refs: string[]): string {
  return refs.length === 1 ? `job ${refs[0]}` : `jobs ${refs.join(", ")}`;
}

// A job reference that did not resolve to exactly one job in the caller's
// company (missing, closed, another company's, or matching several jobs).
export function extraJobNotFoundRefusal(refs: string[]): ExtraJobBillingRefusal {
  const unique = [...new Set(refs)];
  return new ExtraJobBillingRefusal(
    "extra_job_not_found",
    unique,
    `This invoice was not saved. We could not find ${jobList(unique)} in your company. ` +
      "Check the job number, or ask the office to add you to the job, then submit again.",
  );
}

const COMMISSION_ONLY_ON_OWN_JOB =
  "Commission can only be claimed on a job you created.";

// `refs`: ordinary lines on jobs the trade is not on. `commissionRefs`:
// commission lines on jobs the trade did not create (and does not manage,
// and holds no grant for). With only commission refused the code is
// commission_not_allowed, so the app never offers to add them to the job.
export function extraJobNotAllowedRefusal(
  refs: string[],
  commissionRefs: string[] = [],
): ExtraJobBillingRefusal {
  const unique = [...new Set(refs)];
  const commission = [...new Set(commissionRefs)];
  if (unique.length === 0) {
    return new ExtraJobBillingRefusal(
      "commission_not_allowed",
      [],
      `This invoice was not saved. ${COMMISSION_ONLY_ON_OWN_JOB} ` +
        `Take the commission line off ${jobList(commission)}, or ask the office, then submit again.`,
      commission,
    );
  }
  const commissionNote = commission.length > 0
    ? ` ${COMMISSION_ONLY_ON_OWN_JOB} Take the commission line off ${jobList(commission)}.`
    : "";
  return new ExtraJobBillingRefusal(
    "extra_job_not_allowed",
    unique,
    `This invoice was not saved. You are not booked on ${jobList(unique)}. ` +
      "Add yourself to the job on your invoice (pick the job again), or ask the office, then submit again." +
      commissionNote,
    commission,
  );
}

// Commission lines on jobs whose commission record names someone else (or
// nobody). Adding themselves to the job does not help.
export function commissionNotSalespersonRefusal(refs: string[]): ExtraJobBillingRefusal {
  const unique = [...new Set(refs)];
  return new ExtraJobBillingRefusal(
    "commission_not_salesperson",
    [],
    `This invoice was not saved. Commission on ${jobList(unique)} can only be claimed by the salesperson named on its accepted quote. ` +
      "Take the commission line off, or ask the office, then submit again.",
    unique,
  );
}

type JobLine = {
  lineType: string;
  ref: string;
  job: { id: string; job_number?: string | null } | null;
};

// Throws ExtraJobBillingRefusal when any line fails; returns the rule each
// line passed on (index order) when all pass. Reads only, never writes.
export async function assertTradeMayBillExtraJobs(
  client: any,
  input: {
    trade: Omit<ExtraJobBillingTrade, "invoiceAnyJob">;
    lines: JobLine[];
    jobVertical: (job: any) => string;
    // The commission records of these jobs (job_commission.ts). Read only
    // when a line is commission; a failed read refuses the submission.
    readCommissionRecords?: (
      jobIds: string[],
    ) => Promise<ReadonlyMap<string, { salesperson_user_id: string | null }>>;
  },
): Promise<string[]> {
  const { trade, lines } = input;
  if (lines.length === 0) return [];
  const unresolved = lines.filter((line) => !line.job?.id).map((line) => line.ref);
  if (unresolved.length > 0) throw extraJobNotFoundRefusal(unresolved);

  const jobIds = [...new Set(lines.map((line) => String(line.job!.id)))];
  const [jobsRes, bookedRes] = await Promise.all([
    client.from("jobs")
      .select("id, job_number, type, metadata, created_by")
      .eq("org_id", trade.orgId)
      .in("id", jobIds),
    client.from("job_assignments")
      .select("job_id")
      .eq("user_id", trade.id)
      .eq("is_ghost", false)
      .or("status.is.null,status.neq.cancelled")
      .in("job_id", jobIds),
  ]);
  if (jobsRes.error) throw new Error("Could not check the jobs on this invoice");
  if (bookedRes.error) throw new Error("Could not check which jobs you are booked on");
  const jobs = new Map<string, any>();
  for (const row of jobsRes.data || []) {
    if (row?.id) jobs.set(String(row.id), row);
  }
  const booked = new Set(
    (bookedRes.data || []).map((row: any) => String(row?.job_id || "")),
  );

  const missing = lines.filter((line) => !jobs.has(String(line.job!.id)));
  if (missing.length > 0) {
    throw extraJobNotFoundRefusal(missing.map((line) => line.ref));
  }

  let commissionRecords: ReadonlyMap<string, { salesperson_user_id: string | null }> = new Map();
  const commissionJobIds = [
    ...new Set(lines.filter((line) => isCommissionLine(line.lineType)).map((line) => String(line.job!.id))),
  ];
  if (commissionJobIds.length > 0 && input.readCommissionRecords) {
    try {
      commissionRecords = await input.readCommissionRecords(commissionJobIds);
    } catch {
      throw new Error("Could not check the commission on this invoice");
    }
  }

  let invoiceAnyJob: boolean | null = null;
  const passed: string[] = [];
  const refused: string[] = [];
  const refusedCommission: string[] = [];
  const refusedSalesperson: string[] = [];
  for (const line of lines) {
    const row = jobs.get(String(line.job!.id));
    const job: ExtraJobBillingJob = {
      id: String(row.id),
      createdBy: row.created_by ? String(row.created_by) : null,
      vertical: input.jobVertical(row),
      bookedOn: booked.has(String(row.id)),
      commission: commissionRecords.has(String(row.id))
        ? { salespersonUserId: commissionRecords.get(String(row.id))!.salesperson_user_id }
        : null,
    };
    let rule = extraJobBillingRule({
      lineType: line.lineType,
      job,
      trade: { ...trade, invoiceAnyJob: false },
    });
    if (!rule) {
      // Read the grant only when nothing else allows the line.
      if (invoiceAnyJob === null) {
        invoiceAnyJob = await readInvoiceAnyJobPermission(client, {
          id: trade.id,
          orgId: trade.orgId,
        });
      }
      rule = extraJobBillingRule({
        lineType: line.lineType,
        job,
        trade: { ...trade, invoiceAnyJob },
      });
    }
    if (rule) passed.push(rule);
    else if (isCommissionLine(line.lineType) && job.commission) {
      refusedSalesperson.push(String(row.job_number || line.ref));
    } else if (isCommissionLine(line.lineType)) {
      refusedCommission.push(String(row.job_number || line.ref));
    } else refused.push(String(row.job_number || line.ref));
  }
  if (refused.length > 0 || refusedCommission.length > 0) {
    throw extraJobNotAllowedRefusal(refused, [...refusedCommission, ...refusedSalesperson]);
  }
  if (refusedSalesperson.length > 0) throw commissionNotSalespersonRefusal(refusedSalesperson);
  return passed;
}
