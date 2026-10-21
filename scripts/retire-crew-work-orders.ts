#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read
// deno-lint-ignore-file no-explicit-any
/**
 * Cancel the old per-trade crew work orders. Dry-run unless --apply.
 * Never a migration and never a cron: Marnin runs this by hand at go-live,
 * after retire_crew_work_orders_v1 is on. It sets status to cancelled. It
 * does not delete a row.
 *
 * Audit 21 Oct 2026 (project kevgrhcjxspbxgovpmfl), a comment, not a number
 * this script checks: 34 kind='crew' rows, 9 of them status sent, sitting on
 * 4 open jobs. None since June, none invoiced. Quote-builder crew rows
 * (quote_builder_version_id set) are not in that 34 and are not selected.
 *
 * Dry-run prints the live plan and whether the flag is on. It writes nothing.
 * --apply refuses (exit 2) unless retire_crew_work_orders_v1 is enabled, then
 * patches status=cancelled in chunks of 25 and re-reads the same ids.
 *
 * Usage:
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
 *     deno run --allow-env --allow-net --allow-read \
 *     scripts/retire-crew-work-orders.ts
 *   … scripts/retire-crew-work-orders.ts --apply
 */

import {
  planCrewWorkOrderRetirement,
  RETIRE_CREW_WORK_ORDERS_FLAG,
  type CrewRetirementRow,
} from "../supabase/functions/ops-api/crew_invoice_job_work_order.ts";

const PAGE = 1000;
const CHUNK = 25;

function usage(): void {
  console.log(
    "Usage: SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… scripts/retire-crew-work-orders.ts [--apply]",
  );
  console.log(
    "Dry-run is the default. --apply sets status=cancelled only when retire_crew_work_orders_v1 is on.",
  );
  console.log(
    "Audit expectation (not checked): 34 kind=crew rows, 9 sent, 4 open jobs. Quote-builder rows are left.",
  );
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
): Promise<{ status: number; body: any }> {
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
  return { status: response.status, body };
}

function jobStatusOf(row: any): string | null {
  const job = row?.jobs;
  if (!job) return null;
  if (Array.isArray(job)) return job[0]?.status ?? null;
  return job.status ?? null;
}

async function loadCrewRows(base: string, key: string): Promise<CrewRetirementRow[]> {
  const rows: CrewRetirementRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const path =
      "work_orders?kind=eq.crew&quote_builder_version_id=is.null" +
      "&select=id,kind,status,sent_at,job_id,quote_builder_version_id,jobs!work_orders_job_id_fkey(status)" +
      `&order=id.asc&limit=${PAGE}&offset=${offset}`;
    const { status, body } = await rest(base, key, path);
    if (status < 200 || status >= 300 || !Array.isArray(body)) {
      console.error("crew work order read failed", status, body);
      Deno.exit(1);
    }
    for (const row of body) {
      rows.push({
        id: String(row.id),
        kind: row.kind,
        quote_builder_version_id: row.quote_builder_version_id,
        status: row.status,
        sent_at: row.sent_at,
        job_id: row.job_id,
        job_status: jobStatusOf(row),
      });
    }
    if (body.length < PAGE) break;
  }
  return rows;
}

async function flagOn(base: string, key: string): Promise<boolean> {
  const { status, body } = await rest(
    base,
    key,
    `feature_flags?flag_name=eq.${RETIRE_CREW_WORK_ORDERS_FLAG}&select=enabled&limit=1`,
  );
  if (status < 200 || status >= 300) {
    console.error("flag read failed", status, body);
    Deno.exit(1);
  }
  return Array.isArray(body) && body[0]?.enabled === true;
}

function printPlan(plan: ReturnType<typeof planCrewWorkOrderRetirement>, flag: boolean): void {
  console.log(`flag ${RETIRE_CREW_WORK_ORDERS_FLAG}: ${flag}`);
  console.log(`eligible (kind=crew, not quote-builder): ${plan.eligible}`);
  console.log(`already cancelled: ${plan.already_cancelled}`);
  console.log(`to retire: ${plan.to_retire}`);
  console.log(`sent (status=sent, among those to retire): ${plan.sent}`);
  console.log(`with sent_at: ${plan.with_sent_at}`);
  console.log(`open jobs: ${plan.open_jobs}`);
  console.log(`closed jobs: ${plan.closed_jobs}`);
  console.log(`unknown job status: ${plan.unknown_job_status}`);
  console.log(
    "audit expectation, not checked: 34 eligible, 9 sent, 4 open jobs",
  );
}

async function cancelChunk(
  base: string,
  key: string,
  ids: readonly string[],
): Promise<any[]> {
  const list = ids.join(",");
  const path =
    `work_orders?id=in.(${list})&kind=eq.crew&quote_builder_version_id=is.null&status=neq.cancelled`;
  const { status, body } = await rest(base, key, path, {
    method: "PATCH",
    body: JSON.stringify({ status: "cancelled" }),
    headers: { Prefer: "return=representation" },
  });
  if (status < 200 || status >= 300 || !Array.isArray(body)) {
    console.error("cancel failed", status, body);
    Deno.exit(1);
  }
  return body;
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

  const [rows, flag] = await Promise.all([
    loadCrewRows(base, key),
    flagOn(base, key),
  ]);
  const plan = planCrewWorkOrderRetirement(rows);
  printPlan(plan, flag);

  if (!apply) {
    console.log("dry-run: nothing written");
    return;
  }
  if (!flag) {
    console.error(
      `--apply refused: turn on ${RETIRE_CREW_WORK_ORDERS_FLAG} first`,
    );
    Deno.exit(2);
  }
  if (plan.ids.length === 0) {
    console.log("nothing to cancel");
    return;
  }
  const cancelled = new Set<string>();
  for (let i = 0; i < plan.ids.length; i += CHUNK) {
    const chunk = plan.ids.slice(i, i + CHUNK);
    const updated = await cancelChunk(base, key, chunk);
    for (const row of updated) {
      if (row?.status !== "cancelled") {
        console.error("a patched row did not come back cancelled", row?.id, row?.status);
        Deno.exit(1);
      }
      cancelled.add(String(row.id));
    }
    console.log(`patched ${updated.length} of ${chunk.length}`);
  }
  const after = await loadCrewRows(base, key);
  const still = planCrewWorkOrderRetirement(after);
  const missed = plan.ids.filter((id) => {
    const row = after.find((candidate) => candidate.id === id);
    return !row || row.status !== "cancelled";
  });
  if (missed.length || still.to_retire !== 0) {
    console.error("retirement did not finish", {
      missed: missed.length,
      still_to_retire: still.to_retire,
      patched: cancelled.size,
    });
    Deno.exit(1);
  }
  console.log(`cancelled: ${cancelled.size}`);
}

if (import.meta.main) {
  await main();
}
