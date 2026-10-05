// The placement plan for evidence rows about an invoice with no job
// (gap plan B-4, 5 Oct 2026). Pure: no database, no I/O.
//
// An invoice evidence row whose invoice has no job (xero_invoices.job_id null,
// mostly SES cards the money seal will not link) can still go on a job when the
// invoice's reference names exactly one job. That judgement is the unique
// reference matcher's, and only its: this module feeds it the full job
// population and the unlinked invoices and turns its answer into the plan
// public.context_xero_evidence_place(plan, ...) applies. SQL never re-derives
// the rule.
//
//   matches     the matcher's unique matches, for the invoices asked about:
//               {invoice_id, job_id, digits}. The row goes on that job.
//   candidates  every other invoice asked about whose reference names at least
//               one job's identity digits (whole digit runs, the matcher's own
//               primitives): {invoice_id, job_ids}. The row stays off a job, in
//               the review queue, with those candidate jobs.
//
// Nothing here writes xero_invoices.job_id: only the evidence row moves.

import {
  deriveSesUnlinkedInvoiceMatches,
  invoiceNamesBuilderReference,
  isUnlinkedIssuedAccrec,
  sesMatchJobIdentityDigits,
  type SesMatchInvoice,
  type SesMatchJob,
} from "../../ops-api/makesafe_invoice_reference_match.ts";

/** The most candidate jobs one review row carries. */
export const XERO_EVIDENCE_MAX_CANDIDATES = 10;

export interface XeroEvidenceJobRow {
  id: string;
  job_number?: string | null;
  type?: string | null;
  metadata?: Record<string, unknown> | null;
  /** makesafe_job_details.external_ref, when the job has a details row. */
  external_ref?: string | null;
  /** True when the job has a makesafe_job_details row. */
  has_makesafe_details?: boolean;
}

export interface XeroEvidencePlan {
  matches: Array<{ invoice_id: string; job_id: string; digits: string[] }>;
  candidates: Array<{ invoice_id: string; job_ids: string[] }>;
}

export interface XeroEvidencePlanSummary {
  asked: number;
  matched: number;
  with_candidates: number;
  no_candidate: number;
  not_eligible: number;
}

/**
 * The matcher's job shape, with its SES board rule: a make-safe or
 * restoration card, or any job with a make-safe details row. Every job still
 * contests a reference (guard 2 needs the FULL population); only board cards
 * can receive a match.
 */
export function xeroEvidenceMatchJob(row: XeroEvidenceJobRow): SesMatchJob {
  const metadata = row.metadata ?? {};
  const po = metadata["builder_po_number"];
  return {
    id: row.id,
    job_number: row.job_number ?? null,
    external_ref: row.external_ref ?? null,
    builder_po_number: typeof po === "string" ? po : null,
    on_board: row.type === "makesafe" ||
      (row.type === "insurance" &&
        metadata["insurance_job_type"] === "restoration") ||
      row.has_makesafe_details === true,
  };
}

/**
 * Build the plan for the invoices asked about (mirror row ids). `jobs` must be
 * every job; `invoices` every unlinked ACCREC invoice (the matcher keeps only
 * the issued ones).
 */
export function buildXeroInvoiceEvidencePlan(
  jobRows: readonly XeroEvidenceJobRow[],
  invoices: readonly SesMatchInvoice[],
  askedInvoiceIds: readonly string[],
): { plan: XeroEvidencePlan; summary: XeroEvidencePlanSummary } {
  const asked = new Set(askedInvoiceIds.map((id) => id.toLowerCase()));
  const jobs = jobRows.map(xeroEvidenceMatchJob);
  const { matches } = deriveSesUnlinkedInvoiceMatches(jobs, invoices);

  const plan: XeroEvidencePlan = { matches: [], candidates: [] };
  const matched = new Set<string>();
  for (const match of matches) {
    const invoiceId = match.invoice.id.toLowerCase();
    if (!asked.has(invoiceId) || matched.has(invoiceId)) continue;
    matched.add(invoiceId);
    plan.matches.push({
      invoice_id: invoiceId,
      job_id: match.job_id.toLowerCase(),
      digits: [...match.matched_digits],
    });
  }

  let notEligible = 0;
  let noCandidate = 0;
  const seen = new Set<string>();
  for (const invoice of invoices) {
    const invoiceId = invoice.id.toLowerCase();
    if (!asked.has(invoiceId) || matched.has(invoiceId) || seen.has(invoiceId)) {
      continue;
    }
    seen.add(invoiceId);
    if (!isUnlinkedIssuedAccrec(invoice)) {
      notEligible++;
      continue;
    }
    const jobIds = jobs
      .filter((job) =>
        invoiceNamesBuilderReference(
          invoice.reference,
          sesMatchJobIdentityDigits(job),
        ).length > 0
      )
      .map((job) => job.id.toLowerCase())
      .sort()
      .slice(0, XERO_EVIDENCE_MAX_CANDIDATES);
    if (jobIds.length === 0) {
      noCandidate++;
      continue;
    }
    plan.candidates.push({ invoice_id: invoiceId, job_ids: jobIds });
  }
  plan.matches.sort((a, b) => a.invoice_id.localeCompare(b.invoice_id));
  plan.candidates.sort((a, b) => a.invoice_id.localeCompare(b.invoice_id));

  return {
    plan,
    summary: {
      asked: asked.size,
      matched: plan.matches.length,
      with_candidates: plan.candidates.length,
      no_candidate: noCandidate,
      not_eligible: notEligible,
    },
  };
}
