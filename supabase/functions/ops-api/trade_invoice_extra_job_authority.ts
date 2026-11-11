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
};

export type ExtraJobBillingCase = {
  lineType: string;
  job: ExtraJobBillingJob;
  trade: ExtraJobBillingTrade;
};

export const EXTRA_JOB_BILLING_RULES: ReadonlyArray<{
  name: string;
  allows: (c: ExtraJobBillingCase) => boolean;
}> = [
  // (a) The trade has a live assignment on the job (not cancelled, not a
  //     ghost watcher row).
  { name: "booked_on_job", allows: (c) => c.job.bookedOn },
  // (b) A commission line on a job the trade created.
  {
    name: "commission_on_job_they_created",
    allows: (c) =>
      c.lineType === "commission" && !!c.job.createdBy &&
      c.job.createdBy === c.trade.id,
  },
  // (c) The job is in a division the trade manages, or the trade is a
  //     make-safe manager and the job is a make-safe.
  {
    name: "manages_job_division",
    allows: (c) =>
      (!!c.job.vertical && c.trade.managedVerticals.includes(c.job.vertical)) ||
      (c.trade.isMakesafeManager && c.job.vertical === "makesafe"),
  },
  // (d) The office granted this trade invoice-any-job (literal true only).
  { name: "invoice_any_job_grant", allows: (c) => c.trade.invoiceAnyJob },
];

export function extraJobBillingRule(c: ExtraJobBillingCase): string | null {
  return EXTRA_JOB_BILLING_RULES.find((rule) => rule.allows(c))?.name ?? null;
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

export class ExtraJobBillingRefusal extends Error {
  code: "extra_job_not_found" | "extra_job_not_allowed";
  jobs: string[];
  constructor(
    code: "extra_job_not_found" | "extra_job_not_allowed",
    jobs: string[],
    message: string,
  ) {
    super(message);
    this.code = code;
    this.jobs = jobs;
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

export function extraJobNotAllowedRefusal(refs: string[]): ExtraJobBillingRefusal {
  const unique = [...new Set(refs)];
  return new ExtraJobBillingRefusal(
    "extra_job_not_allowed",
    unique,
    `This invoice was not saved. You are not booked on ${jobList(unique)}. ` +
      "Ask the office to add you to the job, then submit again.",
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

  let invoiceAnyJob: boolean | null = null;
  const passed: string[] = [];
  const refused: string[] = [];
  for (const line of lines) {
    const row = jobs.get(String(line.job!.id));
    const job: ExtraJobBillingJob = {
      id: String(row.id),
      createdBy: row.created_by ? String(row.created_by) : null,
      vertical: input.jobVertical(row),
      bookedOn: booked.has(String(row.id)),
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
    else refused.push(String(row.job_number || line.ref));
  }
  if (refused.length > 0) throw extraJobNotAllowedRefusal(refused);
  return passed;
}
