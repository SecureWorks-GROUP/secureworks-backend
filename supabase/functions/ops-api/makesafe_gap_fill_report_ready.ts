// deno-lint-ignore-file no-explicit-any
// "Trade submitted a report, but the reporting pack has not been run yet."
//
// This is the second half of the gap-fill queue (makesafe_gap_fill.ts): the work
// that is READY for the reporting run to convert into a human-review-ready draft.
// It is also what the trade-report-submission ping notifies about (see
// docs/makesafe-gap-fill-ping-design.md).
//
// It reuses the SAME due-predicate the reporting run itself uses
// (selectDraftPackDueJobIds in makesafe_draft_pack.ts) so the queue and the run
// can never disagree about what is "not yet drafted". READ-ONLY. No writes.

import {
  type DraftPackDueDetail,
  type DraftPackDuePack,
  selectDraftPackDueJobIds,
} from "./makesafe_draft_pack.ts";
import { REPORT_DRAFT_READY_SUBSTATUS } from "./makesafe_report_drafts.ts";

export interface ReportReadyItem {
  kind: "report_ready";
  job_id: string;
  job_number: string | null;
  builder: string | null;
  external_ref: string | null;
  client_name: string | null;
  site_suburb: string | null;
  report_received_at: string | null;
  cycle_number: number | null;
  service_report_id: string | null;
  // Always the same: submitted, pack not yet drafted. Kept explicit so the payload
  // is self-describing for the sweeping session.
  why: string;
}

// Detail columns: exactly the due-predicate inputs plus a few display fields.
const DETAIL_COLUMNS = [
  "job_id",
  "substatus",
  "report_received_at",
  "report_sent_at",
  "report_type",
  "external_ref",
  "requesting_company_slug",
  "requesting_company_name",
  "cycle_number",
].join(",");

const REPORT_READY_ID_CHUNK = 25;

async function loadReportReadyRowsByIds(
  ids: string[],
  readChunk: (chunk: string[]) => PromiseLike<{ data: any; error: any }>,
  label: string,
): Promise<any[]> {
  const rows: any[] = [];
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  for (
    let offset = 0;
    offset < uniqueIds.length;
    offset += REPORT_READY_ID_CHUNK
  ) {
    const { data, error } = await readChunk(
      uniqueIds.slice(offset, offset + REPORT_READY_ID_CHUNK),
    );
    if (error) {
      throw new Error(
        `gap-fill report-ready ${label} read failed: ${error.message || error}`,
      );
    }
    rows.push(...(data || []));
  }
  return rows;
}

export async function loadReportReadyItems(
  client: any,
  // The report lifecycle tables (makesafe_job_details / jobs / job_service_reports)
  // are not org-scoped in these scans, matching listDraftPackDueJobs. Accepted for
  // signature parity with the intake-flag loader; intentionally unused.
  _orgId: string,
  limit: number,
): Promise<ReportReadyItem[]> {
  // Scan a padded window of trade-report-in details (mirrors listDraftPackDueJobs).
  const scanLimit = Math.max(50, limit * 4);
  const { data: details, error: detErr } = await client
    .from("makesafe_job_details")
    .select(DETAIL_COLUMNS)
    .eq("substatus", REPORT_DRAFT_READY_SUBSTATUS)
    .limit(scanLimit);
  if (detErr) {
    throw new Error(
      `gap-fill report-ready detail scan failed: ${detErr.message || detErr}`,
    );
  }
  const detailRows = (details || []) as any[];
  const jobIds = detailRows.map((d) => d.job_id).filter(Boolean);
  if (!jobIds.length) return [];

  const packs = await loadReportReadyRowsByIds(
    jobIds,
    (chunk) =>
      client.from("makesafe_report_packs")
        .select(
          "job_id,pack_kind,status,report_doc_id,invoice_doc_id,xero_invoice_id",
        )
        .in("job_id", chunk),
    "pack scan",
  );

  const dueIds = selectDraftPackDueJobIds(
    detailRows as DraftPackDueDetail[],
    (packs || []) as DraftPackDuePack[],
    limit,
    "main",
  );
  if (!dueIds.length) return [];

  // Display data: job header + the submitted service report for the current cycle.
  const jobs = await loadReportReadyRowsByIds(
    dueIds,
    (chunk) =>
      client.from("jobs")
        .select("id,job_number,client_name,site_suburb")
        .in("id", chunk),
    "job",
  );
  const jobById = new Map<string, any>();
  for (const j of jobs || []) jobById.set(j.id, j);

  const reports = await loadReportReadyRowsByIds(
    dueIds,
    (chunk) =>
      client.from("job_service_reports")
        .select("id,job_id,status,cycle_number,submitted_at")
        .in("job_id", chunk)
        .eq("status", "submitted"),
    "service-report",
  );
  // Keep the latest submitted report per job.
  const reportByJob = new Map<string, any>();
  for (const r of reports || []) {
    const prior = reportByJob.get(r.job_id);
    if (
      !prior || String(r.submitted_at ?? "") > String(prior.submitted_at ?? "")
    ) {
      reportByJob.set(r.job_id, r);
    }
  }

  const detailByJob = new Map<string, any>();
  for (const d of detailRows) detailByJob.set(d.job_id, d);

  return dueIds
    .map((jobId): ReportReadyItem => {
      const d = detailByJob.get(jobId) || {};
      const j = jobById.get(jobId) || {};
      const r = reportByJob.get(jobId) || {};
      return {
        kind: "report_ready",
        job_id: jobId,
        job_number: j.job_number ?? null,
        builder: d.requesting_company_slug ?? d.requesting_company_name ?? null,
        external_ref: d.external_ref ?? null,
        client_name: j.client_name ?? null,
        site_suburb: j.site_suburb ?? null,
        report_received_at: d.report_received_at ?? null,
        cycle_number: d.cycle_number ?? r.cycle_number ?? null,
        service_report_id: r.id ?? null,
        why: "trade report submitted; make-safe report pack not yet drafted",
      };
    });
}
