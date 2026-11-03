// Recent invoice evidence onto its job, after each invoice sync (gap plan B-4).
//
// The payment trigger, ops-api and xero-sync write evidence rows about an
// invoice that land on no job when the invoice has none. Each run, rows
// recorded in the last XERO_EVIDENCE_PLACE_WINDOW_DAYS days go through
// public.context_xero_evidence_place: the invoice's own job when it now has
// one; otherwise the one job the unique reference matcher names (plan built by
// _shared/evidence/xero_invoice_evidence_plan.ts); otherwise the review queue
// with candidate jobs. Older rows are the reviewed data file's, never this.
//
// Two modes, both only while the attribution lane is on:
//   own_job  always. Only rows whose invoice now has a job go to that job (an
//            empty plan: nothing is matched, guessed or queued). A payment that
//            arrived before its invoice was placed follows the invoice in the
//            same sync pass that links it (finish line B3, 3 Nov 2026: INV-1688
//            was linked at 11:34Z and its 28 Oct payment stayed on no job).
//   full     with feature flag context_xero_evidence_place_v1 on (missing or
//            unreadable is off): own_job plus the reference matcher's plan and
//            the review queue.
// Any read failure writes nothing: the matcher's guard needs the FULL job
// population, so a partial read must never feed it. Never writes xero_invoices.

import { automationLaneEnabled } from "../_shared/automation_switch.ts";
import {
  buildXeroInvoiceEvidencePlan,
  type XeroEvidenceJobRow,
  type XeroEvidencePlan,
} from "../_shared/evidence/xero_invoice_evidence_plan.ts";
import type { SesMatchInvoice } from "../ops-api/makesafe_invoice_reference_match.ts";

export const XERO_EVIDENCE_PLACE_FLAG = "context_xero_evidence_place_v1";
export const XERO_EVIDENCE_PLACE_WINDOW_DAYS = 14;
const PAGE = 1000;

export type InvoiceEvidencePlaceResult =
  | { ran: false; reason: string }
  | {
    ran: true;
    mode: "own_job" | "full";
    since: string;
    by_class: Record<string, number>;
    plan: { matches: number; candidates: number } | null;
    written: Record<string, number> | null;
  };

// deno-lint-ignore no-explicit-any
async function flagOn(sb: any): Promise<boolean> {
  try {
    const { data, error } = await sb.from("feature_flags").select("enabled")
      .eq("flag_name", XERO_EVIDENCE_PLACE_FLAG).limit(1);
    if (error) return false;
    return data?.[0]?.enabled === true;
  } catch {
    return false;
  }
}

/** Every row of a select, page by page; null when any page fails. */
// deno-lint-ignore no-explicit-any
async function readAll<T>(build: () => any): Promise<T[] | null> {
  const rows: T[] = [];
  for (let from = 0;; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error || !Array.isArray(data)) return null;
    rows.push(...data);
    if (data.length < PAGE) return rows;
  }
}

/** The matcher's inputs: every job (with its details reference) and every unlinked ACCREC invoice. */
// deno-lint-ignore no-explicit-any
export async function loadXeroEvidenceMatcherInputs(sb: any): Promise<
  { jobs: XeroEvidenceJobRow[]; invoices: SesMatchInvoice[] } | null
> {
  const jobs = await readAll<{ id: string; job_number: string | null; type: string | null; metadata: Record<string, unknown> | null }>(
    () => sb.from("jobs").select("id, job_number, type, metadata").order("id"),
  );
  const details = await readAll<{ job_id: string; external_ref: string | null }>(
    () => sb.from("makesafe_job_details").select("job_id, external_ref").order("job_id"),
  );
  const invoices = await readAll<SesMatchInvoice>(
    () =>
      sb.from("xero_invoices").select("id, invoice_number, reference, status, invoice_type, job_id")
        .eq("invoice_type", "ACCREC").is("job_id", null).order("id"),
  );
  if (!jobs || !details || !invoices) return null;
  const refByJob = new Map(details.map((d) => [d.job_id, d.external_ref]));
  return {
    jobs: jobs.map((j) => ({
      id: j.id,
      job_number: j.job_number,
      type: j.type,
      metadata: j.metadata,
      external_ref: refByJob.get(j.id) ?? null,
      has_makesafe_details: refByJob.has(j.id),
    })),
    invoices,
  };
}

// deno-lint-ignore no-explicit-any
export async function placeRecentInvoiceEvidence(sb: any, now = new Date()): Promise<InvoiceEvidencePlaceResult> {
  const mode = (await flagOn(sb)) ? "full" : "own_job";
  if (!(await automationLaneEnabled(sb, "attribution"))) return { ran: false, reason: "attribution_lane_off" };
  const since = new Date(now.getTime() - XERO_EVIDENCE_PLACE_WINDOW_DAYS * 86_400_000).toISOString();

  const { data: dry, error: dryError } = await sb.rpc("context_xero_evidence_place", {
    p_plan: {},
    p_dry_run: true,
    p_since: since,
    p_limit: 2000,
  });
  if (dryError || !dry) return { ran: false, reason: "dry_run_failed" };
  // own_job: with an empty plan the real call can place only rows whose invoice has a job.
  const unlinked: string[] = mode === "full" && Array.isArray(dry.unlinked_invoices) ? dry.unlinked_invoices : [];
  const toWrite = mode === "full" ? Number(dry.to_write ?? 0) : Number(dry.by_class?.invoice_job ?? 0);
  if (toWrite === 0 && unlinked.length === 0) {
    return { ran: true, mode, since, by_class: dry.by_class ?? {}, plan: null, written: null };
  }

  let plan: XeroEvidencePlan = { matches: [], candidates: [] };
  if (unlinked.length > 0) {
    const inputs = await loadXeroEvidenceMatcherInputs(sb);
    if (!inputs) return { ran: false, reason: "matcher_inputs_unreadable" };
    plan = buildXeroInvoiceEvidencePlan(inputs.jobs, inputs.invoices, unlinked).plan;
  }

  const { data: real, error: realError } = await sb.rpc("context_xero_evidence_place", {
    p_plan: plan,
    p_dry_run: false,
    p_since: since,
    p_limit: 2000,
  });
  if (realError || !real) return { ran: false, reason: "place_failed" };
  return {
    ran: true,
    mode,
    since,
    by_class: real.by_class ?? {},
    plan: { matches: plan.matches.length, candidates: plan.candidates.length },
    written: real.written ?? null,
  };
}
