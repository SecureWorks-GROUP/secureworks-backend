// deno-lint-ignore-file no-explicit-any
// Supplier-bill to job matching for job profit.
//
// Exact job-number tokens only (SWF-261308, SWP-261247, SWMS-261114, ...).
// A bill that names two real jobs, or one job number that is stored twice,
// is ambiguous and is never written. A token that is not a real job number
// does not block the one real job named beside it. Nothing here guesses.
//
// job_profit_unmatched_bills is a read. job_profit_link_bill is the office
// write. The dry-run script is scripts/job-profit-bill-match.ts. Neither
// the read nor a migration links a bill.

export const JOB_NUMBER_RE =
  /(?<![A-Za-z0-9])(SWMS|SWP|SWF|SWD|SWI|SWR|SWM|SWG|SW)-(\d{4,6})(?!\d)/gi;

const TRADE_MIRROR_LINE_RE = /\| SW - [A-Z]/;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LINKABLE_STATUSES = new Set(["AUTHORISED", "PAID"]);
const DEFAULT_DAYS = 90;
const MAX_DAYS = 3650;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export type MatchOutcome = "exact" | "ambiguous" | "unmatched";

export type JobNumberMatch = {
  outcome: MatchOutcome;
  job_number: string | null;
  job_id: string | null;
  tokens: string[];
  real_job_numbers: string[];
};

export type BillJobNumberFields = {
  reference: string[];
  lines: string[];
  tracking: string[];
  all: string[];
};

export type QueueResult = { status: number; body: Record<string, unknown> };

/**
 * Office queue: privileged ops key, or an admin, owner or ops_manager
 * session. Trades, the routine and a read-only agent are refused even
 * when the role string is an office role.
 */
export function jobProfitBillQueueCallerAllowed(
  authMode: string,
  role: string | null | undefined,
): boolean {
  if (authMode === "api_key") return true;
  if (authMode !== "jwt") return false;
  const r = String(role || "").toLowerCase();
  return r === "admin" || r === "owner" || r === "ops_manager";
}

export function extractJobNumberTokens(text: string | null | undefined): string[] {
  if (!text) return [];
  const re = new RegExp(JOB_NUMBER_RE.source, "gi");
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    out.push(`${match[1].toUpperCase()}-${match[2]}`);
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function lineItemsOf(raw: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(raw)
    ? raw
    : asRecord(raw)?.LineItems ?? asRecord(raw)?.lineItems;
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => asRecord(row) !== null) as Record<string, unknown>[];
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function billJobNumberFields(bill: {
  reference?: string | null;
  line_items?: unknown;
}): BillJobNumberFields {
  const reference = extractJobNumberTokens(bill.reference ?? "");
  const lines: string[] = [];
  const tracking: string[] = [];
  for (const item of lineItemsOf(bill.line_items)) {
    lines.push(...extractJobNumberTokens(
      textOf(item.Description) || textOf(item.description),
    ));
    const track = item.Tracking ?? item.tracking;
    if (!Array.isArray(track)) continue;
    for (const entry of track) {
      const row = asRecord(entry);
      if (!row) continue;
      tracking.push(...extractJobNumberTokens(
        [
          textOf(row.Name),
          textOf(row.name),
          textOf(row.Option),
          textOf(row.option),
        ].filter(Boolean).join(" "),
      ));
    }
  }
  const all = [...new Set([...reference, ...lines, ...tracking])].sort();
  return { reference, lines, tracking, all };
}

/**
 * jobsByNumber maps an uppercase job number to the job ids stored under it.
 * One id is a real job. Two ids for one number is ambiguous. A token with
 * no id is not a job.
 */
export function classifyJobNumberMatch(
  tokens: readonly string[],
  jobsByNumber: ReadonlyMap<string, readonly string[]>,
): JobNumberMatch {
  const unique = [...new Set(tokens.map((token) => token.toUpperCase()))].sort();
  const real: string[] = [];
  let multi = false;
  for (const token of unique) {
    const ids = [...new Set(jobsByNumber.get(token) ?? [])];
    if (ids.length === 0) continue;
    real.push(token);
    if (ids.length !== 1) multi = true;
  }
  real.sort();
  if (multi || real.length > 1) {
    return {
      outcome: "ambiguous",
      job_number: null,
      job_id: null,
      tokens: unique,
      real_job_numbers: real,
    };
  }
  if (real.length === 1) {
    const jobNumber = real[0];
    return {
      outcome: "exact",
      job_number: jobNumber,
      job_id: (jobsByNumber.get(jobNumber) ?? [])[0] ?? null,
      tokens: unique,
      real_job_numbers: real,
    };
  }
  return {
    outcome: "unmatched",
    job_number: null,
    job_id: null,
    tokens: unique,
    real_job_numbers: [],
  };
}

export function isTradeMirrorBill(
  xeroInvoiceId: string | null | undefined,
  lineItems: unknown,
  tradeBillIds: ReadonlySet<string>,
): boolean {
  if (xeroInvoiceId && tradeBillIds.has(xeroInvoiceId)) return true;
  for (const item of lineItemsOf(lineItems)) {
    const description = textOf(item.Description) || textOf(item.description);
    if (TRADE_MIRROR_LINE_RE.test(description)) return true;
  }
  return false;
}

export type CohortBill = {
  id: string;
  job_id: string | null;
  xero_invoice_id: string;
  reference: string | null;
  line_items: unknown;
  trade_mirror: boolean;
};

export type CohortSummary = {
  scanned: number;
  trade_mirrors_excluded: number;
  already_linked: number;
  exact_unique: number;
  ambiguous: number;
  unmatched: number;
  line_text_hits: number;
  reference_hits: number;
  tracking_hits: number;
  apply_count: number;
};

function hasToken(tokens: string[]): boolean {
  return tokens.length > 0;
}

/**
 * Counts for one scanned set. Already-linked and trade-mirror bills are
 * not classified. apply_count is the exact unique matches a later --apply
 * would be allowed to write; ambiguous bills are not in it.
 */
export function summariseSupplierBills(
  bills: readonly CohortBill[],
  jobsByNumber: ReadonlyMap<string, readonly string[]>,
  sealedJobIds: ReadonlySet<string> = new Set(),
): CohortSummary {
  const summary: CohortSummary = {
    scanned: bills.length,
    trade_mirrors_excluded: 0,
    already_linked: 0,
    exact_unique: 0,
    ambiguous: 0,
    unmatched: 0,
    line_text_hits: 0,
    reference_hits: 0,
    tracking_hits: 0,
    apply_count: 0,
  };
  for (const bill of bills) {
    if (bill.trade_mirror || isTradeMirrorBill(bill.xero_invoice_id, bill.line_items, new Set())) {
      summary.trade_mirrors_excluded += 1;
      continue;
    }
    if (bill.job_id) {
      summary.already_linked += 1;
      continue;
    }
    const fields = billJobNumberFields(bill);
    if (hasToken(fields.lines)) summary.line_text_hits += 1;
    if (hasToken(fields.reference)) summary.reference_hits += 1;
    if (hasToken(fields.tracking)) summary.tracking_hits += 1;
    const match = classifyJobNumberMatch(fields.all, jobsByNumber);
    if (match.outcome === "exact") {
      summary.exact_unique += 1;
      if (match.job_id && !sealedJobIds.has(match.job_id)) summary.apply_count += 1;
    } else if (match.outcome === "ambiguous") {
      summary.ambiguous += 1;
    } else {
      summary.unmatched += 1;
    }
  }
  return summary;
}

/**
 * The audit's shape, not a production count: 649 recent non-trade supplier
 * bills (33 already linked, 616 not), 53 of the unlinked ones naming a job
 * number in line text, none in the reference or the tracking category, and
 * 4 trade-mirror bills excluded from that 649.
 */
export function auditShapedCohort(): {
  bills: CohortBill[];
  jobsByNumber: Map<string, string[]>;
} {
  const jobsByNumber = new Map<string, string[]>();
  for (let n = 1; n <= 42; n++) {
    const suffix = String(261000 + n);
    jobsByNumber.set(`SWF-${suffix}`, [`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`]);
  }
  const bills: CohortBill[] = [];
  for (let n = 1; n <= 33; n++) {
    bills.push({
      id: `linked-${n}`,
      job_id: `already-${n}`,
      xero_invoice_id: `LINKED-${n}`,
      reference: "PO-54000",
      line_items: [{ Description: "Supplier materials", Tracking: [{ Name: "Business Unit", Option: "SW - FENCING" }] }],
      trade_mirror: false,
    });
  }
  for (let n = 1; n <= 40; n++) {
    const suffix = String(261000 + n);
    bills.push({
      id: `exact-${n}`,
      job_id: null,
      xero_invoice_id: `EXACT-${n}`,
      reference: "PO-54000",
      line_items: [{
        Description: `Materials for SWF-${suffix}`,
        Tracking: [{ Name: "Business Unit", Option: "SW - FENCING" }],
      }],
      trade_mirror: false,
    });
  }
  for (let n = 1; n <= 8; n++) {
    bills.push({
      id: `ambig-${n}`,
      job_id: null,
      xero_invoice_id: `AMBIG-${n}`,
      reference: "PO-54000",
      line_items: [{
        Description: "Split delivery SWF-261041 and SWF-261042",
        Tracking: [{ Name: "Business Unit", Option: "SW - FENCING" }],
      }],
      trade_mirror: false,
    });
  }
  for (let n = 1; n <= 5; n++) {
    bills.push({
      id: `unknown-${n}`,
      job_id: null,
      xero_invoice_id: `UNKNOWN-${n}`,
      reference: "PO-54000",
      line_items: [{
        Description: `Site SWF-${999000 + n}`,
        Tracking: [{ Name: "Business Unit", Option: "SW - FENCING" }],
      }],
      trade_mirror: false,
    });
  }
  for (let n = 1; n <= 563; n++) {
    bills.push({
      id: `plain-${n}`,
      job_id: null,
      xero_invoice_id: `PLAIN-${n}`,
      reference: "PO-54000",
      line_items: [{
        Description: "Timber",
        Tracking: [{ Name: "Business Unit", Option: "SW - FENCING" }],
      }],
      trade_mirror: false,
    });
  }
  for (let n = 1; n <= 4; n++) {
    bills.push({
      id: `mirror-${n}`,
      job_id: null,
      xero_invoice_id: `MIRROR-${n}`,
      reference: null,
      line_items: [{ Description: "POSSIBLE DUPLICATE\nJOB | SW - FENCING\nLabour" }],
      trade_mirror: true,
    });
  }
  return { bills, jobsByNumber };
}

type BillRow = {
  id: string;
  xero_invoice_id: string | null;
  invoice_number: string | null;
  reference: string | null;
  contact_name: string | null;
  sub_total: number | null;
  status: string | null;
  invoice_type: string | null;
  invoice_date: string | null;
  job_id: string | null;
  line_items: unknown;
};

function fail(status: number, code: string, error: string): QueueResult {
  return { status, body: { ok: false, code, error } };
}

function intParam(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (n < min || n > max) return null;
  return n;
}

function sinceDate(days: number, now: Date): string {
  const ms = now.getTime() - days * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

export async function jobProfitUnmatchedBillsAction(
  client: any,
  params: URLSearchParams,
  now: Date = new Date(),
): Promise<QueueResult> {
  const days = intParam(params.get("days"), DEFAULT_DAYS, 1, MAX_DAYS);
  const limit = intParam(params.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = intParam(params.get("offset"), 0, 0, 1_000_000);
  if (days === null || limit === null || offset === null) {
    return fail(400, "bad_window", "days is 1 to 3650, limit is 1 to 200, offset is 0 or more");
  }

  const { data, error } = await client
    .from("xero_invoices")
    .select("id, xero_invoice_id, invoice_number, reference, contact_name, sub_total, status, invoice_type, invoice_date, job_id, line_items")
    .eq("invoice_type", "ACCPAY")
    .in("status", ["AUTHORISED", "PAID"])
    .is("job_id", null)
    .gte("invoice_date", sinceDate(days, now))
    .order("invoice_date", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + limit);
  if (error) return fail(500, "bills_unreadable", "supplier bills could not be read");

  const rows = (Array.isArray(data) ? data : []) as BillRow[];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const xeroIds = page
    .map((row) => row.xero_invoice_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  let tradeBillIds = new Set<string>();
  if (xeroIds.length > 0) {
    const trade = await client
      .from("trade_invoices")
      .select("xero_bill_id")
      .in("xero_bill_id", xeroIds);
    if (trade.error) return fail(500, "bills_unreadable", "trade bill ids could not be read");
    const tradeRows = (Array.isArray(trade.data) ? trade.data : []) as { xero_bill_id?: string | null }[];
    tradeBillIds = new Set<string>(
      tradeRows
        .map((row) => row.xero_bill_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    );
  }

  const kept = page.filter((row) =>
    !isTradeMirrorBill(row.xero_invoice_id, row.line_items, tradeBillIds)
  );
  const tokens = [...new Set(kept.flatMap((row) => billJobNumberFields(row).all))];
  const jobsByNumber = new Map<string, string[]>();
  if (tokens.length > 0) {
    const jobs = await client
      .from("jobs")
      .select("id, job_number")
      .in("job_number", tokens);
    if (jobs.error) return fail(500, "bills_unreadable", "job numbers could not be read");
    for (const job of Array.isArray(jobs.data) ? jobs.data : []) {
      const number = typeof job.job_number === "string" ? job.job_number.toUpperCase() : "";
      const id = typeof job.id === "string" ? job.id : "";
      if (!number || !id) continue;
      const list = jobsByNumber.get(number) ?? [];
      list.push(id);
      jobsByNumber.set(number, list);
    }
  }

  const bills = kept.map((row) => {
    const fields = billJobNumberFields(row);
    const match = classifyJobNumberMatch(fields.all, jobsByNumber);
    return {
      invoice_id: row.id,
      xero_invoice_id: row.xero_invoice_id,
      invoice_number: row.invoice_number,
      reference: row.reference,
      contact_name: row.contact_name,
      sub_total: row.sub_total,
      status: row.status,
      invoice_date: row.invoice_date,
      outcome: match.outcome,
      suggested_job_number: match.job_number,
      suggested_job_id: match.job_id,
      tokens: match.tokens,
      real_job_numbers: match.real_job_numbers,
    };
  });

  return {
    status: 200,
    body: {
      ok: true,
      days,
      limit,
      offset,
      has_more: hasMore,
      bills,
    },
  };
}

async function readInvoice(client: any, invoiceId: string): Promise<
  { row: BillRow | null; error: boolean }
> {
  const { data, error } = await client
    .from("xero_invoices")
    .select("id, xero_invoice_id, invoice_number, reference, contact_name, sub_total, status, invoice_type, invoice_date, job_id, line_items")
    .eq("id", invoiceId)
    .limit(1);
  if (error) return { row: null, error: true };
  const rows = Array.isArray(data) ? data : [];
  return { row: (rows[0] as BillRow | undefined) ?? null, error: false };
}

export async function jobProfitLinkBillAction(
  client: any,
  body: Record<string, unknown> | null | undefined,
  actor: { user_id: string | null; email: string | null },
): Promise<QueueResult> {
  const invoiceId = typeof body?.invoice_id === "string" ? body.invoice_id : "";
  const jobId = typeof body?.job_id === "string" ? body.job_id : "";
  if (!UUID_RE.test(invoiceId) || !UUID_RE.test(jobId)) {
    return fail(400, "bad_link", "invoice_id and job_id are both required uuids");
  }

  const invoice = await readInvoice(client, invoiceId);
  if (invoice.error) return fail(500, "bill_unreadable", "the supplier bill could not be read");
  if (!invoice.row) return fail(404, "bill_not_found", "no supplier bill with that id");
  if (invoice.row.job_id === jobId) {
    return {
      status: 200,
      body: { ok: true, invoice_id: invoiceId, job_id: jobId, audit_written: false, already_linked: true },
    };
  }
  if (invoice.row.job_id) {
    return fail(409, "bill_already_linked", "this bill is already linked to a different job");
  }
  if (invoice.row.invoice_type !== "ACCPAY" || !LINKABLE_STATUSES.has(String(invoice.row.status || ""))) {
    return fail(409, "bill_not_linkable", "only an authorised or paid supplier bill can be linked");
  }

  const trade = await client
    .from("trade_invoices")
    .select("xero_bill_id")
    .eq("xero_bill_id", invoice.row.xero_invoice_id)
    .limit(1);
  if (trade.error) return fail(500, "bill_unreadable", "trade bill ids could not be read");
  const tradeRows = (Array.isArray(trade.data) ? trade.data : []) as { xero_bill_id?: string | null }[];
  const tradeIds = new Set<string>(
    tradeRows
      .map((row) => row.xero_bill_id)
      .filter((id): id is string => typeof id === "string"),
  );
  if (isTradeMirrorBill(invoice.row.xero_invoice_id, invoice.row.line_items, tradeIds)) {
    return fail(409, "trade_mirror_bill", "a trade invoice mirror is not a supplier bill");
  }

  const jobRead = await client
    .from("jobs")
    .select("id, job_number, ses_money_sealed_at")
    .eq("id", jobId)
    .limit(1);
  if (jobRead.error) return fail(500, "job_unreadable", "the job could not be read");
  const job = (Array.isArray(jobRead.data) ? jobRead.data : [])[0] as
    | { id: string; ses_money_sealed_at?: string | null }
    | undefined;
  if (!job) return fail(404, "job_not_found", "no job with that id");
  if (job.ses_money_sealed_at) {
    return fail(409, "sealed_ses_release_required", "a sealed make-safe job is not linked from this queue");
  }

  const updated = await client
    .from("xero_invoices")
    .update({ job_id: jobId })
    .eq("id", invoiceId)
    .is("job_id", null)
    .select("id");
  if (updated.error) return fail(500, "link_failed", "the bill could not be linked");
  const wrote = Array.isArray(updated.data) ? updated.data.length : 0;
  if (wrote === 0) {
    const again = await readInvoice(client, invoiceId);
    if (again.error) return fail(500, "bill_unreadable", "the supplier bill could not be re-read");
    if (again.row?.job_id === jobId) {
      return {
        status: 200,
        body: { ok: true, invoice_id: invoiceId, job_id: jobId, audit_written: false, already_linked: true },
      };
    }
    return fail(409, "bill_already_linked", "this bill is already linked to a different job");
  }

  const event = await client.from("job_events").insert({
    job_id: jobId,
    user_id: actor.user_id,
    event_type: "job_profit_bill_linked",
    detail_json: {
      invoice_id: invoiceId,
      xero_invoice_id: invoice.row.xero_invoice_id,
      actor_email: actor.email,
    },
  });
  return {
    status: 200,
    body: {
      ok: true,
      invoice_id: invoiceId,
      job_id: jobId,
      audit_written: !event.error,
      already_linked: false,
    },
  };
}

/** One dispatch so index.ts names each action once, in its case label. */
export async function jobProfitBillQueueDispatch(
  action: string,
  client: any,
  url: { searchParams: URLSearchParams },
  body: Record<string, unknown> | null | undefined,
  actor: { user_id: string | null; email: string | null },
): Promise<QueueResult> {
  if (action === "job_profit_unmatched_bills") {
    return await jobProfitUnmatchedBillsAction(client, url.searchParams);
  }
  return await jobProfitLinkBillAction(client, body, actor);
}
