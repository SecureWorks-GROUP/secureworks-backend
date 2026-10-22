// Dry-run matcher for supplier bills that name a job number.
//
// Read only. Prints every proposed match: bill id, contact, amount, job
// number and the matched text. It does not write a proposal and does not
// set xero_invoices.job_id. Supplier bills are linked by job number through
// xero-sync bill prematch (Bills to place). There is no second writer.
//
//   deno run --allow-env --allow-net scripts/job-profit-bill-match.ts
//   deno run --allow-env scripts/job-profit-bill-match.ts --fixture
//
// --fixture prints the audit-shaped cohort and needs no credentials.
// --apply is refused. Do not run this against production as a writer.
//
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for a live read.

import {
  auditShapedCohort,
  billJobNumberFields,
  classifySupplierBill,
  summariseSupplierBills,
  type BillClassification,
  type CohortBill,
  type KnownJob,
} from "../supabase/functions/ops-api/job_profit_bill_match.ts";

const PAGE = 1000;

type LiveBill = CohortBill & {
  contact_name: string | null;
  amount_ex: number | null;
};

function argValue(name: string): string | null {
  const index = Deno.args.indexOf(name);
  if (index < 0) return null;
  return Deno.args[index + 1] ?? null;
}

function printSummary(summary: ReturnType<typeof summariseSupplierBills>, label: string) {
  console.log(JSON.stringify({ label, ...summary }, null, 2));
}

function requireEnv(): { url: string; key: string } {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) {
    console.error(
      "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or pass --fixture for the audit-shaped cohort. This script does not write proposals.",
    );
    Deno.exit(2);
  }
  return { url: url.replace(/\/$/, ""), key };
}

async function restGet(
  base: string,
  key: string,
  path: string,
  from: number,
  to: number,
): Promise<unknown[]> {
  const response = await fetch(`${base}/rest/v1/${path}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      Range: `${from}-${to}`,
      "Range-Unit": "items",
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`PostgREST ${response.status} ${path}: ${text.slice(0, 400)}`);
  }
  const body = await response.json();
  return Array.isArray(body) ? body : [];
}

async function restAll(
  base: string,
  key: string,
  path: string,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    const page = await restGet(base, key, path, from, from + PAGE - 1) as Record<string, unknown>[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

function sinceDate(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function holdingOf(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const value = (metadata as Record<string, unknown>).do_not_schedule;
  return value === true || String(value).toLowerCase() === "true";
}

function printMatch(bill: LiveBill, classified: BillClassification) {
  if (
    classified.outcome === "unmatched" &&
    (classified.tokens.length === 0)
  ) {
    return;
  }
  if (classified.outcome === "already_linked" || classified.outcome === "already_fact") return;
  console.log(JSON.stringify({
    xero_invoice_id: bill.xero_invoice_id,
    contact: bill.contact_name,
    amount: bill.amount_ex,
    job_number: classified.job_number,
    matched_text: classified.matched_text,
    outcome: classified.outcome,
  }));
}

async function loadLive(days: number): Promise<{
  bills: LiveBill[];
  jobsByNumber: Map<string, KnownJob[]>;
  factInvoiceIds: Set<string>;
  classified: Map<string, BillClassification>;
}> {
  const { url, key } = requireEnv();
  const since = sinceDate(days);
  const select = [
    "id",
    "xero_invoice_id",
    "reference",
    "contact_name",
    "sub_total",
    "status",
    "job_id",
    "line_items",
    "invoice_type",
    "invoice_date",
  ].join(",");
  const raw = await restAll(
    url,
    key,
    `xero_invoices?select=${select}&invoice_type=eq.ACCPAY&status=in.(AUTHORISED,PAID)&invoice_date=gte.${since}&order=invoice_date.desc`,
  );
  const trade = await restAll(
    url,
    key,
    "trade_invoices?select=xero_bill_id&xero_bill_id=not.is.null",
  );
  const tradeIds = new Set(
    trade
      .map((row) => row.xero_bill_id)
      .filter((id): id is string => typeof id === "string"),
  );
  const facts = await restAll(
    url,
    key,
    "job_materials_facts?select=xero_invoice_id&xero_invoice_id=not.is.null",
  );
  const factInvoiceIds = new Set(
    facts
      .map((row) => row.xero_invoice_id)
      .filter((id): id is string => typeof id === "string"),
  );

  const bills: LiveBill[] = [];
  const tokens = new Set<string>();
  for (const row of raw) {
    const xeroId = typeof row.xero_invoice_id === "string" ? row.xero_invoice_id : "";
    const mirror = tradeIds.has(xeroId);
    const bill: LiveBill = {
      id: String(row.id),
      job_id: typeof row.job_id === "string" ? row.job_id : null,
      xero_invoice_id: xeroId,
      reference: typeof row.reference === "string" ? row.reference : null,
      line_items: row.line_items,
      trade_mirror: mirror,
      contact_name: typeof row.contact_name === "string" ? row.contact_name : null,
      amount_ex: typeof row.sub_total === "number" ? row.sub_total : null,
    };
    bills.push(bill);
    if (!bill.job_id && !factInvoiceIds.has(xeroId)) {
      for (const token of billJobNumberFields(bill).all) tokens.add(token);
    }
  }

  const jobsByNumber = new Map<string, KnownJob[]>();
  const tokenList = [...tokens];
  for (let i = 0; i < tokenList.length; i += 100) {
    const slice = tokenList.slice(i, i + 100);
    const filter = slice.map((token) => `"${token}"`).join(",");
    const jobs = await restAll(
      url,
      key,
      `jobs?select=id,job_number,status,metadata&job_number=in.(${filter})`,
    );
    for (const job of jobs) {
      const number = typeof job.job_number === "string" ? job.job_number.toUpperCase() : "";
      const id = typeof job.id === "string" ? job.id : "";
      if (!number || !id) continue;
      const list = jobsByNumber.get(number) ?? [];
      list.push({
        id,
        status: typeof job.status === "string" ? job.status : null,
        holding: holdingOf(job.metadata),
      });
      jobsByNumber.set(number, list);
    }
  }

  const classified = new Map<string, BillClassification>();
  for (const bill of bills) {
    const row = classifySupplierBill(bill, jobsByNumber, factInvoiceIds, tradeIds);
    classified.set(bill.xero_invoice_id, row);
    printMatch(bill, row);
  }
  return { bills, jobsByNumber, factInvoiceIds, classified };
}

async function main() {
  const fixture = Deno.args.includes("--fixture");
  const apply = Deno.args.includes("--apply");
  const daysRaw = argValue("--days");
  const days = daysRaw === null ? 90 : Number(daysRaw);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    console.error("--days must be an integer from 1 to 3650");
    Deno.exit(2);
  }
  if (apply) {
    console.error(
      "This script does not write proposals. Supplier bills are linked by job number through xero-sync bill prematch (Bills to place). There is no second writer.",
    );
    Deno.exit(2);
  }
  if (fixture) {
    const cohort = auditShapedCohort();
    printSummary(summariseSupplierBills(cohort.bills, cohort.jobsByNumber), "audit-shaped fixture, not a production count");
    for (const bill of cohort.bills) {
      const classified = classifySupplierBill(bill, cohort.jobsByNumber);
      if (classified.outcome === "exact" || classified.outcome === "split" || classified.outcome === "ambiguous") {
        console.log(JSON.stringify({
          xero_invoice_id: bill.xero_invoice_id,
          contact: null,
          amount: null,
          job_number: classified.job_number,
          matched_text: classified.matched_text,
          outcome: classified.outcome,
        }));
      }
    }
    return;
  }
  const live = await loadLive(days);
  const summary = summariseSupplierBills(live.bills, live.jobsByNumber, live.factInvoiceIds);
  printSummary(summary, `ACCPAY AUTHORISED/PAID last ${days} days, read only`);
  console.log("Dry run. No proposal was written. Supplier bills are linked by job number through the Bills to place sync.");
}

if (import.meta.main) {
  await main();
}
