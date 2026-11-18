#!/usr/bin/env -S deno run --allow-env --allow-net
// deno-lint-ignore-file no-explicit-any
/**
 * P1-05.5: show, read only, that a ZZTEST job that went live got its job work
 * order amount from its sealed budget, to the cent.
 *
 * The director runs this by hand, once, against a ZZTEST job and keeps the
 * output. It only reads (GET). It refuses any job number that does not start
 * with ZZTEST-. A failed or missing read exits non-zero and never prints a
 * figure as zero.
 *
 * Prints: budget_amount, work_order_amount, equal: true|false.
 * equal is true only when both amounts are known and match to the cent.
 *
 * Usage:
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
 *     deno run --allow-env --allow-net \
 *     scripts/prove-work-order-from-scope.ts --job-number ZZTEST-…
 */

import { budgetAgreedLabour } from "../supabase/functions/ops-api/job_labour_cap.ts";

export const ZZTEST_PREFIX = "ZZTEST-";

/** Whole cents, or null when the value is not a finite non-negative number. */
export function toCents(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

/** Pure. The comparison the script prints. */
export function compareWorkOrderToBudget(budget: unknown, workOrderAmount: unknown): {
  budget_amount: string | null;
  work_order_amount: string | null;
  equal: boolean;
} {
  const b = toCents(budgetAgreedLabour(budget));
  const w = toCents(workOrderAmount);
  return {
    budget_amount: b === null ? null : (b / 100).toFixed(2),
    work_order_amount: w === null ? null : (w / 100).toFixed(2),
    equal: b !== null && w !== null && b === w,
  };
}

/** The job number from --job-number, or null when absent or not a ZZTEST job. */
export function parseJobNumber(args: string[]): string | null {
  const i = args.indexOf("--job-number");
  const raw = i >= 0 ? args[i + 1] : args.find((a) => a.startsWith("--job-number="))?.slice(13);
  const value = String(raw ?? "").trim();
  return value.startsWith(ZZTEST_PREFIX) && value.length > ZZTEST_PREFIX.length ? value : null;
}

function fail(code: string, exit = 1): never {
  console.error(code);
  Deno.exit(exit);
}

async function get(base: string, key: string, path: string): Promise<any[]> {
  let response: Response;
  try {
    response = await fetch(`${base}/rest/v1/${path}`, {
      method: "GET",
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
  } catch {
    fail(`read_failed ${path.split("?")[0]}`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    fail(`read_failed ${path.split("?")[0]} http_${response.status}`);
  }
  const body = await response.json().catch(() => null);
  if (!Array.isArray(body)) fail(`read_failed ${path.split("?")[0]} not_a_list`);
  return body;
}

async function main(): Promise<void> {
  const jobNumber = parseJobNumber(Deno.args);
  if (!jobNumber) {
    console.error("Usage: scripts/prove-work-order-from-scope.ts --job-number ZZTEST-…");
    fail("refused_not_zztest_job", 2);
  }
  const base = Deno.env.get("SUPABASE_URL")?.trim();
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (!base || !key) fail("missing_env SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY", 2);

  const jobs = await get(
    base,
    key,
    `jobs?select=id,job_number&job_number=eq.${encodeURIComponent(jobNumber)}&limit=2`,
  );
  if (jobs.length !== 1) fail(jobs.length === 0 ? "job_not_found" : "job_number_not_unique");
  const jobId = String(jobs[0].id);

  // Newest budget for the job (job_budgets is keyed by job_id and version).
  const budgets = await get(
    base,
    key,
    `job_budgets?select=id,scope_revision_id,version,labour:budget->labour` +
      `&job_id=eq.${jobId}&order=version.desc&limit=1`,
  );
  const workOrders = await get(
    base,
    key,
    `work_orders?select=id,status,agreed_labour_ex,quote_filled_scope_revision_id` +
      `&job_id=eq.${jobId}&kind=eq.job&limit=2`,
  );
  if (workOrders.length > 1) fail("more_than_one_job_work_order");

  const budget = budgets[0] ?? null;
  const workOrder = workOrders[0] ?? null;
  const result = compareWorkOrderToBudget(
    budget ? { labour: budget.labour } : null,
    workOrder?.agreed_labour_ex ?? null,
  );
  console.log(`job_number: ${jobNumber}`);
  console.log(`budget_found: ${budget !== null}`);
  console.log(`budget_scope_revision_id: ${budget?.scope_revision_id ?? "none"}`);
  console.log(`work_order_found: ${workOrder !== null}`);
  console.log(`work_order_status: ${workOrder?.status ?? "none"}`);
  console.log(`work_order_scope_revision_id: ${workOrder?.quote_filled_scope_revision_id ?? "none"}`);
  console.log(`budget_amount: ${result.budget_amount ?? "none"}`);
  console.log(`work_order_amount: ${result.work_order_amount ?? "none"}`);
  console.log(`equal: ${result.equal}`);
}

if (import.meta.main) await main();
