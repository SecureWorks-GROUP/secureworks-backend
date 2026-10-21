// Dry-run matcher for supplier bills that name a job number.
//
// Default is read-only. --apply writes xero_invoices.job_id for an exact
// unique match only, and still skips an ambiguous bill and a sealed
// make-safe job. It is not run by a migration, a cron or CI.
//
//   deno run --allow-env --allow-net scripts/job-profit-bill-match.ts
//   deno run --allow-env --allow-net scripts/job-profit-bill-match.ts --days 90
//   deno run --allow-env scripts/job-profit-bill-match.ts --fixture
//
// --fixture prints the audit-shaped cohort and needs no credentials.
// --apply is refused together with --fixture. Do not pass --apply until
// a dry-run has been read.
//
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for a live read.

import {
  auditShapedCohort,
  billJobNumberFields,
  classifyJobNumberMatch,
  isTradeMirrorBill,
  summariseSupplierBills,
  type CohortBill,
} from "../supabase/functions/ops-api/job_profit_bill_match.ts";

const PAGE = 1000;

type LiveBill = CohortBill & {
  invoice_id: string;
  status: string | null;
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
      "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or pass --fixture for the audit-shaped cohort. This script does not write unless --apply is passed.",
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

async function loadLive(days: number): Promise<{
  bills: CohortBill[];
  jobsByNumber: Map<string, readonly string[]>;
  sealedJobIds: Set<string>;
  live: LiveBill[];
}> {
  const { url, key } = requireEnv();
  const since = sinceDate(days);
  const select = [
    "id",
    "xero_invoice_id",
    "reference",
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

  const bills: CohortBill[] = [];
  const live: LiveBill[] = [];
  const tokens = new Set<string>();
  for (const row of raw) {
    const xeroId = typeof row.xero_invoice_id === "string" ? row.xero_invoice_id : "";
    const mirror = isTradeMirrorBill(xeroId, row.line_items, tradeIds);
    const bill: CohortBill = {
      id: String(row.id),
      job_id: typeof row.job_id === "string" ? row.job_id : null,
      xero_invoice_id: xeroId,
      reference: typeof row.reference === "string" ? row.reference : null,
      line_items: row.line_items,
      trade_mirror: mirror,
    };
    bills.push(bill);
    if (!mirror && !bill.job_id) {
      for (const token of billJobNumberFields(bill).all) tokens.add(token);
    }
    live.push({ ...bill, invoice_id: bill.id, status: typeof row.status === "string" ? row.status : null });
  }

  const jobsByNumber = new Map<string, string[]>();
  const tokenList = [...tokens];
  for (let i = 0; i < tokenList.length; i += 100) {
    const slice = tokenList.slice(i, i + 100);
    const filter = slice.map((token) => `"${token}"`).join(",");
    const jobs = await restAll(
      url,
      key,
      `jobs?select=id,job_number,ses_money_sealed_at&job_number=in.(${filter})`,
    );
    for (const job of jobs) {
      const number = typeof job.job_number === "string" ? job.job_number.toUpperCase() : "";
      const id = typeof job.id === "string" ? job.id : "";
      if (!number || !id) continue;
      const list = jobsByNumber.get(number) ?? [];
      list.push(id);
      jobsByNumber.set(number, list);
    }
  }

  const sealedJobIds = new Set<string>();
  const candidateIds = [...jobsByNumber.values()].flat();
  for (let i = 0; i < candidateIds.length; i += 100) {
    const slice = candidateIds.slice(i, i + 100);
    const filter = slice.map((id) => `"${id}"`).join(",");
    const jobs = await restAll(
      url,
      key,
      `jobs?select=id,ses_money_sealed_at&id=in.(${filter})`,
    );
    for (const job of jobs) {
      if (typeof job.id === "string" && job.ses_money_sealed_at) sealedJobIds.add(job.id);
    }
  }

  return { bills, jobsByNumber, sealedJobIds, live };
}

async function applyExact(
  bills: LiveBill[],
  jobsByNumber: ReadonlyMap<string, readonly string[]>,
  sealedJobIds: ReadonlySet<string>,
) {
  const { url, key } = requireEnv();
  let wrote = 0;
  let skipped = 0;
  for (const bill of bills) {
    if (bill.trade_mirror || bill.job_id) continue;
    const match = classifyJobNumberMatch(billJobNumberFields(bill).all, jobsByNumber);
    if (match.outcome !== "exact" || !match.job_id) {
      skipped += 1;
      continue;
    }
    if (sealedJobIds.has(match.job_id)) {
      skipped += 1;
      continue;
    }
    const response = await fetch(
      `${url}/rest/v1/xero_invoices?id=eq.${bill.invoice_id}&job_id=is.null`,
      {
        method: "PATCH",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify({ job_id: match.job_id }),
      },
    );
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`link ${bill.invoice_id} failed ${response.status}: ${text.slice(0, 300)}`);
    }
    const body = await response.json();
    if (Array.isArray(body) && body.length === 1) wrote += 1;
    else skipped += 1;
  }
  console.log(JSON.stringify({ apply: true, wrote, skipped }));
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
  if (fixture && apply) {
    console.error("--fixture cannot be combined with --apply");
    Deno.exit(2);
  }
  if (fixture) {
    const cohort = auditShapedCohort();
    printSummary(summariseSupplierBills(cohort.bills, cohort.jobsByNumber), "audit-shaped fixture, not a production count");
    return;
  }
  const live = await loadLive(days);
  const summary = summariseSupplierBills(live.bills, live.jobsByNumber, live.sealedJobIds);
  printSummary(summary, `ACCPAY AUTHORISED/PAID last ${days} days, read only`);
  if (!apply) {
    console.log("Dry run. No bill was linked. Pass --apply only after this count has been read.");
    return;
  }
  await applyExact(live.live, live.jobsByNumber, live.sealedJobIds);
}

if (import.meta.main) {
  await main();
}
