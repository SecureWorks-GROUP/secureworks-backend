#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read
// deno-lint-ignore-file no-explicit-any
/**
 * Open a blank job work order for jobs touched in the last 30 days that
 * do not already have one. Dry-run unless --apply. Never a migration and
 * never a cron: Marnin runs this by hand at go-live.
 *
 * Dry-run calls preview_active_job_work_orders() and prints counts by type
 * and status. It writes nothing and does not need a flag.
 *
 * --apply calls apply_active_job_work_orders() only when BOTH
 * job_work_order_all_types_v1 and job_work_order_active_backfill_v1 are on.
 * The database refuses the same call (42501) if either is off.
 *
 * Audit 21 Oct 2026 (project kevgrhcjxspbxgovpmfl), a comment, not a number
 * this script checks: 414 open jobs, 38 already with a job work order; open
 * jobs with no work order and touched in 30 days about 97 (makesafe 52,
 * patio 22, repair 16, fencing 7). 211 of 312 open make-safe jobs sat in
 * processing and were outside that 30-day set. A processing make-safe that
 * HAS been touched inside 30 days is included.
 *
 * Usage:
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
 *     deno run --allow-env --allow-net --allow-read \
 *     scripts/backfill-job-work-orders-active.ts
 *   … scripts/backfill-job-work-orders-active.ts --apply
 */

const ALL_TYPES = "job_work_order_all_types_v1";
const BACKFILL = "job_work_order_active_backfill_v1";

function usage(): void {
  console.log(
    "Usage: SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… scripts/backfill-job-work-orders-active.ts [--apply]",
  );
  console.log("Dry-run is the default. --apply writes only when both flags are on.");
}

function envOrExit(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) {
    usage();
    console.error(`missing ${name}`);
    Deno.exit(2);
  }
  return value;
}

async function rest(
  base: string,
  key: string,
  path: string,
  init: RequestInit = {},
): Promise<any> {
  const response = await fetch(`${base}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    console.error(path, response.status, body);
    Deno.exit(1);
  }
  return body;
}

function tally(rows: readonly any[], key: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const name = String(row?.[key] || "(blank)");
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return counts;
}

function printTally(label: string, counts: Map<string, number>): void {
  console.log(label);
  const names = [...counts.keys()].sort((a, b) => a.localeCompare(b));
  if (names.length === 0) console.log("  (none)");
  for (const name of names) console.log(`  ${name}  ${counts.get(name)}`);
}

async function flagOn(base: string, key: string, name: string): Promise<boolean> {
  const rows = await rest(
    base,
    key,
    `feature_flags?flag_name=eq.${encodeURIComponent(name)}&select=enabled&limit=1`,
  );
  return Array.isArray(rows) && rows[0]?.enabled === true;
}

async function main(): Promise<void> {
  const apply = Deno.args.includes("--apply");
  const unknown = Deno.args.filter((arg) => arg !== "--apply");
  if (unknown.length) {
    usage();
    console.error(`unknown argument ${unknown[0]}`);
    Deno.exit(2);
  }
  const base = envOrExit("SUPABASE_URL").replace(/\/$/, "");
  const key = envOrExit("SUPABASE_SERVICE_ROLE_KEY");

  const rows = await rest(base, key, "rpc/preview_active_job_work_orders", {
    method: "POST",
    body: "{}",
    headers: { Prefer: "return=representation" },
  });
  const list = Array.isArray(rows) ? rows : [];
  console.log(`preview rows: ${list.length}`);
  printTally("by type:", tally(list, "job_type"));
  printTally("by status:", tally(list, "status"));
  if (list.length >= 1000) {
    console.log(
      "warning: the preview returned 1000 rows, which is the PostgREST page ceiling. Re-read before --apply.",
    );
  }

  const allTypes = await flagOn(base, key, ALL_TYPES);
  const backfill = await flagOn(base, key, BACKFILL);
  console.log(`${ALL_TYPES}: ${allTypes}`);
  console.log(`${BACKFILL}: ${backfill}`);

  if (!apply) {
    console.log("dry-run: nothing written");
    return;
  }
  if (!allTypes || !backfill) {
    console.error(
      "--apply refused: turn on job_work_order_all_types_v1 and job_work_order_active_backfill_v1 first",
    );
    Deno.exit(2);
  }
  const result = await rest(base, key, "rpc/apply_active_job_work_orders", {
    method: "POST",
    body: "{}",
  });
  console.log(`opened: ${result?.opened ?? "?"}`);
  console.log(`as_of: ${result?.as_of ?? "?"}`);
}

if (import.meta.main) {
  await main();
}
