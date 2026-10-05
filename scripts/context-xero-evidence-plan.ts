#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read --allow-write
/**
 * Xero evidence placement plan (gap plan B-4). STRICT READ-ONLY.
 *
 * Builds, from LIVE production, the plan public.context_xero_evidence_place
 * applies to invoice evidence rows with no job: for each invoice with no job
 * that such a row is about, the one job the unique reference matcher names
 * (`matches`), or the jobs its reference names when there is no unique match
 * (`candidates`). The rule is the matcher's
 * (supabase/functions/ops-api/makesafe_invoice_reference_match.ts) through
 * supabase/functions/_shared/evidence/xero_invoice_evidence_plan.ts, the same
 * code xero-sync runs; this script is I/O only and writes nothing to the
 * database. Needs migration 20261005230000 live.
 *
 * Usage:
 *   SUPABASE_ACCESS_TOKEN=... deno run --allow-env --allow-net --allow-read \
 *     --allow-write scripts/context-xero-evidence-plan.ts --out=plan.json
 * Paste the file's JSON into the placement data file between its $plan$ marks.
 */
import {
  assertNoPiiColumns,
  assertReadOnlySql,
} from "./ses-c2-measure-board-evidence.ts";
import {
  buildXeroInvoiceEvidencePlan,
  type XeroEvidenceJobRow,
} from "../supabase/functions/_shared/evidence/xero_invoice_evidence_plan.ts";
import type { SesMatchInvoice } from "../supabase/functions/ops-api/makesafe_invoice_reference_match.ts";

const PROJECT_REF = "kevgrhcjxspbxgovpmfl";
const MANAGEMENT_QUERY_URL =
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

/** The rows with no job, by class, and the unlinked invoices they are about (a dry run: writes nothing). */
export const ROWS_SQL =
  `select public.context_xero_evidence_place('{}'::jsonb, true) as r`;

/** The FULL job population: every job contests a builder reference. */
export const JOBS_SQL = `
  select j.id, j.job_number, j.type,
    j.metadata->>'builder_po_number' as builder_po_number,
    j.metadata->>'insurance_job_type' as insurance_job_type,
    d.external_ref, d.job_id is not null as has_makesafe_details
  from jobs j
  left join lateral (
    select m.job_id, m.external_ref from makesafe_job_details m where m.job_id = j.id limit 1
  ) d on true
  order by j.id`;

export const INVOICES_SQL = `
  select x.id, x.invoice_number, x.reference, x.status, x.invoice_type, x.job_id
  from xero_invoices x
  where x.invoice_type = 'ACCREC' and x.job_id is null
  order by x.id`;

async function query<T>(sql: string): Promise<T[]> {
  assertReadOnlySql(sql);
  assertNoPiiColumns(sql);
  const token = Deno.env.get("SUPABASE_ACCESS_TOKEN")?.trim();
  if (!token) throw new Error("SUPABASE_ACCESS_TOKEN is required");
  const response = await fetch(MANAGEMENT_QUERY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "SecureWorks-Context-Xero-Evidence-Plan/1.0",
    },
    body: JSON.stringify({ query: sql, read_only: true }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(payload)) {
    throw new Error(`read-only query failed: HTTP ${response.status}`);
  }
  return payload as T[];
}

if (import.meta.main) {
  const outArg = Deno.args.find((a) => a.startsWith("--out="));
  const [{ r }] = await query<{ r: { unlinked_invoices?: string[]; by_class?: unknown } }>(ROWS_SQL);
  const asked = r.unlinked_invoices ?? [];
  const jobs = (await query<{
    id: string;
    job_number: string | null;
    type: string | null;
    builder_po_number: string | null;
    insurance_job_type: string | null;
    external_ref: string | null;
    has_makesafe_details: boolean;
  }>(JOBS_SQL)).map((j): XeroEvidenceJobRow => ({
    id: j.id,
    job_number: j.job_number,
    type: j.type,
    metadata: { builder_po_number: j.builder_po_number, insurance_job_type: j.insurance_job_type },
    external_ref: j.external_ref,
    has_makesafe_details: j.has_makesafe_details,
  }));
  const invoices = await query<SesMatchInvoice>(INVOICES_SQL);
  const { plan, summary } = buildXeroInvoiceEvidencePlan(jobs, invoices, asked);
  const text = JSON.stringify(plan);
  if (outArg) await Deno.writeTextFile(outArg.slice("--out=".length), text + "\n");
  else console.log(text);
  console.error(JSON.stringify({ rows_without_job_by_class: r.by_class, jobs: jobs.length, unlinked_invoices: invoices.length, ...summary }));
}
