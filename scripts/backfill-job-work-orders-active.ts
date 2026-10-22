#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read
// deno-lint-ignore-file no-explicit-any
/**
 * Open a blank job work order for open jobs with real activity in the last
 * 30 days that do not already have one. Activity is an assignment, a time
 * entry, an invoice line, or a status change. jobs.updated_at does not
 * qualify. Dry-run unless --apply. Never a migration and never a cron:
 * Marnin runs this by hand at go-live.
 *
 * Dry-run calls preview_active_job_work_orders() and prints JSON
 * { job_ids, rows, by_type, by_status }. It writes nothing and does not
 * need a flag. Save that JSON and review the ids.
 *
 * --apply --file <that json> calls apply_active_job_work_orders(uuid[])
 * with those ids only. It does not preview again. Apply re-checks every
 * id for 30-day activity, an open status, a non-blank type, and no
 * existing job work order, and reports skipped_jobs with the reason
 * (not_found, blank_type, not_open, already_has_work_order,
 * no_recent_activity). It runs only when BOTH
 * job_work_order_all_types_v1 and job_work_order_active_backfill_v1 are on.
 * The database refuses the same call (42501) if either is off. A missing
 * file, or a file with no valid ids, exits 2.
 *
 * Audit 21 Oct 2026 selected by jobs.updated_at (about 94, then 97 in an
 * earlier note). That is not this selector. Do not treat either count as
 * what a later dry-run must print.
 *
 * Usage:
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
 *     deno run --allow-env --allow-net --allow-read \
 *     scripts/backfill-job-work-orders-active.ts
 *   … scripts/backfill-job-work-orders-active.ts --apply --file preview.json
 */
import { reviewedBackfillJobIds } from "../supabase/functions/ops-api/crew_invoice_job_work_order.ts";

const ALL_TYPES = "job_work_order_all_types_v1";
const BACKFILL = "job_work_order_active_backfill_v1";

function usage(): void {
  console.log(
    "Usage: SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… scripts/backfill-job-work-orders-active.ts [--apply --file <preview.json>]",
  );
  console.log("Dry-run is the default. --apply writes only the reviewed ids, and only when both flags are on.");
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

function parseArgs(): { apply: boolean; file: string | null } {
  let apply = false;
  let file: string | null = null;
  const args = Deno.args;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--file") {
      const next = args[i + 1];
      if (!next || next.startsWith("--")) {
        usage();
        console.error("--file needs a path");
        Deno.exit(2);
      }
      file = next;
      i++;
      continue;
    }
    usage();
    console.error(`unknown argument ${arg}`);
    Deno.exit(2);
  }
  return { apply, file };
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

function tally(rows: readonly any[], key: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const name = String(row?.[key] || "(blank)");
    counts[name] = (counts[name] || 0) + 1;
  }
  return counts;
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
  const { apply, file } = parseArgs();
  const base = envOrExit("SUPABASE_URL").replace(/\/$/, "");
  const key = envOrExit("SUPABASE_SERVICE_ROLE_KEY");

  if (!apply) {
    const rows = await rest(base, key, "rpc/preview_active_job_work_orders", {
      method: "POST",
      body: "{}",
      headers: { Prefer: "return=representation" },
    });
    const list = Array.isArray(rows) ? rows : [];
    const payload = {
      job_ids: list.map((row) => String(row.job_id)),
      rows: list,
      by_type: tally(list, "job_type"),
      by_status: tally(list, "status"),
    };
    console.log(JSON.stringify(payload, null, 2));
    if (list.length >= 1000) {
      console.error(
        "warning: the preview returned 1000 rows, which is the PostgREST page ceiling. Re-read before --apply.",
      );
    }
    return;
  }

  if (!file) {
    usage();
    console.error("--apply needs --file, the reviewed dry-run JSON. It does not select again.");
    Deno.exit(2);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Deno.readTextFile(file));
  } catch (error) {
    console.error(`could not read ${file}: ${(error as Error).message}`);
    Deno.exit(2);
  }
  const ids = reviewedBackfillJobIds(parsed);
  if (!ids) {
    console.error("--apply refused: the file has no valid job ids");
    Deno.exit(2);
  }
  const allTypes = await flagOn(base, key, ALL_TYPES);
  const backfill = await flagOn(base, key, BACKFILL);
  if (!allTypes || !backfill) {
    console.error(
      "--apply refused: turn on job_work_order_all_types_v1 and job_work_order_active_backfill_v1 first",
    );
    Deno.exit(2);
  }
  const result = await rest(base, key, "rpc/apply_active_job_work_orders", {
    method: "POST",
    body: JSON.stringify({ p_job_ids: ids }),
  });
  console.log(JSON.stringify(result));
}

if (import.meta.main) {
  await main();
}
