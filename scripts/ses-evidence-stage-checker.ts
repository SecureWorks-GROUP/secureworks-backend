#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read --allow-write
// deno-lint-ignore-file no-explicit-any
/**
 * Read-only SES board evidence/stage checker.
 *
 * Production safety:
 * - the Supabase client is wired through readOnlyFetch, which rejects every
 *   method except GET/HEAD before the request can leave this process;
 * - every database read is SELECT-style and every list is paged with .range();
 * - the report is assembled from job/work-order references only. Client names,
 *   addresses, phones and emails never enter the report model.
 *
 * Rule table (the generated report repeats this with the same source anchors):
 * - Board population: `makesafe` jobs plus `insurance` restoration jobs, with
 *   active/history and cancelled reads combined
 *   (ops-api/index.ts:14327-14352,14580-14605).
 * - Stage vocabulary: New, Allocated, Trade Report In, Report Ready/Docs Ready,
 *   Completed, Archive, Cancelled
 *   (makesafe_board_read_model.ts:26-63).
 * - Allocated: an active assignment bound to the current attendance cycle
 *   (makesafe_state_projection.ts:311-321,686-715,810-815).
 * - Trade Report In, physical: submitted/approved current-cycle service report
 *   plus the completion-photo floor, currently five
 *   (makesafe_state_projection.ts:746-765,802-809;
 *    makesafe_computed_status.ts:229-255).
 * - Trade Report In, portal/report family: every typed portal/document role
 *   required by the family rule
 *   (makesafe_state_projection.ts:752-765,802-809).
 * - Docs Ready: READY/READY_TO_BUILD, or a legacy unsent pack with its draft
 *   invoice and required pack artifacts; the underlying report evidence must
 *   still pass
 *   (makesafe_computed_status.ts:258-284).
 * - Completed/Archive: exact-cycle terminal proof in v2. The compatibility
 *   model also recognises a durable sent-pack record plus an issued/paid ACCREC
 *   invoice, with its stricter document fallback
 *   (makesafe_state_projection.ts:736-793;
 *    makesafe_computed_status.ts:286-310).
 * - Required close-out documents: invoice and, for physical work, report;
 *   SWMS is additionally required for MLB and Western/Builderwest work
 *   (ops-api/index.ts:12893-12943).
 * - Raw `jobs.status=invoiced` is independently checked for a linked, live
 *   ACCREC invoice because invoiced is a job state, not a board column
 *   (ops-api/index.ts:12836-12838,13122-13125,14409-14416).
 * - A terminal display overlay is not operational closure. Terminal conflicts
 *   are deliberately protected for review
 *   (makesafe_state_reconcile.ts:338-389).
 */

const PROJECT_REF = "kevgrhcjxspbxgovpmfl";
const DEFAULT_SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;
const PAGE_SIZE = 1000;
const IN_CHUNK_SIZE = 100;
const SENT_PACK_STATUSES = new Set([
  "sent",
  "sent_marker_failed",
  "sent_not_closed",
  "close_failed",
]);
const ACTIVE_ASSIGNMENT_STATUSES = new Set([
  "assigned",
  "accepted",
  "scheduled",
  "travel",
  "travelling",
  "arrived",
  "in_progress",
  "started",
]);
const ISSUED_INVOICE_STATUSES = new Set([
  "AUTHORISED",
  "SUBMITTED",
  "PAID",
]);
const DURABLE_INVOICE_STATUSES = new Set(["AUTHORISED", "PAID"]);
const STAGE_RANK: Record<string, number> = {
  new: 0,
  allocated: 1,
  trade_report_in: 2,
  report_ready: 3,
  completed: 4,
  archive: 5,
};
const TERMINAL_JOB_STATUSES = new Set([
  "invoiced",
  "complete",
  "completed",
  "closed",
  "archived",
]);

export type SesStage =
  | "new"
  | "allocated"
  | "trade_report_in"
  | "report_ready"
  | "completed"
  | "archive"
  | "cancelled";

export interface RawJob {
  id: string;
  job_number: string | null;
  type: string | null;
  status: string | null;
  archived?: boolean | null;
  created_at?: string | null;
  updated_at?: string | null;
  completed_at?: string | null;
  insurance_job_type?: string | null;
  synthetic_livefire_marker?: string | null;
}

export interface RawDocument {
  id?: string | null;
  job_id: string;
  type?: string | null;
  file_name?: string | null;
}

export interface RawInvoice {
  id?: string | null;
  job_id: string;
  status?: string | null;
  invoice_type?: string | null;
  invoice_date?: string | null;
  created_at?: string | null;
}

export interface RawPack {
  id?: string | null;
  job_id: string;
  pack_kind?: string | null;
  status?: string | null;
  review_state?: string | null;
  report_doc_id?: string | null;
  invoice_doc_id?: string | null;
  swms_doc_id?: string | null;
  sent_at?: string | null;
}

export interface DocumentFlags {
  has_invoice_doc: boolean;
  has_report_doc: boolean;
  has_swms_doc: boolean;
}

export interface AuditFinding {
  job_ref: string;
  claimed_stage: SesStage;
  evidence_stage: SesStage;
  code: string;
  severity: "critical" | "error" | "warning";
  detail: string;
}

export interface AuditJobResult {
  job_ref: string;
  claimed_stage: SesStage;
  evidence_stage: SesStage;
  report_in: boolean;
  docs_ready: boolean;
  terminal_proven: boolean;
  findings: AuditFinding[];
}

export interface ProjectionHealth {
  complete: boolean;
  requested_job_count: number;
  projected_job_count: number;
  differing_job_count: number;
  projection_input_error_job_count: number;
  duplicate_job_ids: string[];
}

export interface AuditInput {
  canonicalRows: any[];
  rawJobs: RawJob[];
  documents: RawDocument[];
  invoices: RawInvoice[];
  packs: RawPack[];
  documentFlagsByJob: Map<string, DocumentFlags>;
  swmsRequiredJobIds: Set<string>;
  v2RowsByJob: Map<string, any>;
  projectionHealth: ProjectionHealth | null;
  v2LoadError: string | null;
  generatedAt: string;
  pageStats: Record<string, { pages: number; rows: number }>;
}

interface PagedBoardPopulation {
  rows: RawJob[];
  terminalSyntheticJobIds: Set<string>;
}

export interface AuditResult {
  generated_at: string;
  population_count: number;
  canonical_board_count: number;
  coverage_missing_from_board: string[];
  coverage_extra_on_board: string[];
  claimed_stage_counts: Record<string, number>;
  evidence_stage_counts: Record<string, number>;
  failure_counts: Record<string, number>;
  severity_counts: Record<string, number>;
  v2_blocker_counts: Record<string, number>;
  v2_diagnostic_counts: Record<string, number>;
  projection_health: ProjectionHealth | null;
  v2_load_error: string | null;
  page_stats: Record<string, { pages: number; rows: number }>;
  jobs: AuditJobResult[];
}

export const RULES = [
  {
    stage: "Board population",
    requirement:
      "`makesafe` plus `insurance/restoration`; full history and cancelled reads are combined.",
    source: "supabase/functions/ops-api/index.ts:14327-14352,14580-14605",
  },
  {
    stage: "Allocated",
    requirement:
      "At least one active assignment already scoped by the canonical current-cycle read.",
    source:
      "supabase/functions/ops-api/makesafe_state_projection.ts:311-321,686-715,810-815",
  },
  {
    stage: "Trade Report In (physical)",
    requirement:
      "Submitted/approved current-cycle report and at least five completion photos.",
    source:
      "supabase/functions/ops-api/makesafe_state_projection.ts:746-765,802-809; supabase/functions/ops-api/makesafe_computed_status.ts:229-255",
  },
  {
    stage: "Trade Report In (portal/report)",
    requirement:
      "Every typed current-cycle portal/document role required by the family rule.",
    source:
      "supabase/functions/ops-api/makesafe_state_projection.ts:752-765,802-809",
  },
  {
    stage: "Docs Ready",
    requirement:
      "Current READY/READY_TO_BUILD decision, or a legacy unsent draft pack with draft invoice and required artifacts; report evidence still passes.",
    source: "supabase/functions/ops-api/makesafe_computed_status.ts:258-284",
  },
  {
    stage: "Completed / Archive",
    requirement:
      "Exact-cycle terminal proof, or the compatibility close-out proof: durable sent pack plus issued/paid ACCREC invoice (with the documented strict fallback).",
    source:
      "supabase/functions/ops-api/makesafe_state_projection.ts:736-793; supabase/functions/ops-api/makesafe_computed_status.ts:286-310",
  },
  {
    stage: "Close-out documents",
    requirement:
      "Invoice; report for physical work; SWMS additionally for MLB and Western/Builderwest.",
    source: "supabase/functions/ops-api/index.ts:12893-12943",
  },
  {
    stage: "Raw invoiced job state",
    requirement: "A linked, non-void ACCREC invoice must exist.",
    source:
      "supabase/functions/ops-api/index.ts:12836-12838,13122-13125,14409-14416",
  },
  {
    stage: "Cancelled",
    requirement:
      "Raw job state is cancelled/canceled or the v2 cancellation decision is confirmed.",
    source:
      "supabase/functions/ops-api/index.ts:13113-13121; supabase/functions/ops-api/makesafe_state_projection.ts:1048-1063",
  },
  {
    stage: "Terminal display conflicts",
    requirement:
      "Displayed Completed/Archive is not accepted as operational proof by itself; conflicts remain review work.",
    source: "supabase/functions/ops-api/makesafe_state_reconcile.ts:338-389",
  },
] as const;

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function stage(value: unknown): SesStage {
  const normalized = text(value).toLowerCase();
  if (
    [
      "new",
      "allocated",
      "trade_report_in",
      "report_ready",
      "completed",
      "archive",
      "cancelled",
    ].includes(normalized)
  ) {
    return normalized as SesStage;
  }
  throw new Error(`Unknown SES stage: ${normalized || "(blank)"}`);
}

function groupByJob<T extends { job_id: string }>(
  rows: readonly T[],
): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const row of rows) {
    const jobId = text(row.job_id);
    if (!jobId) continue;
    result.set(jobId, [...(result.get(jobId) || []), row]);
  }
  return result;
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return Object.fromEntries(
    Object.entries(counts).sort((a, b) =>
      b[1] - a[1] || a[0].localeCompare(b[0])
    ),
  );
}

function isWithinSevenDays(value: string | null, nowIso: string): boolean {
  if (!value) return true;
  const at = Date.parse(value);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(at) || !Number.isFinite(now)) return true;
  return now - at < 7 * 86_400_000;
}

function strongestInvoice(rows: readonly RawInvoice[]): RawInvoice | null {
  const rank: Record<string, number> = {
    PAID: 5,
    AUTHORISED: 4,
    SUBMITTED: 3,
    DRAFT: 2,
  };
  return [...rows]
    .filter((row) =>
      text(row.invoice_type).toUpperCase() === "ACCREC" &&
      !["VOIDED", "DELETED"].includes(text(row.status).toUpperCase())
    )
    .sort((a, b) => {
      const statusDiff = (rank[text(b.status).toUpperCase()] || 1) -
        (rank[text(a.status).toUpperCase()] || 1);
      if (statusDiff) return statusDiff;
      return text(b.invoice_date || b.created_at).localeCompare(
        text(a.invoice_date || a.created_at),
      );
    })[0] || null;
}

function mainPacks(rows: readonly RawPack[]): RawPack[] {
  return rows.filter((row) =>
    !text(row.pack_kind) || text(row.pack_kind).toLowerCase() === "main"
  );
}

function reportEvidence(row: any): {
  satisfied: boolean;
  physical: boolean;
  submitted: boolean;
  photos: number;
} {
  const physical = text(row?.computed_status_job_type) ===
    "physical_makesafe";
  const submitted =
    row?.computed_status_evidence?.has_submitted_service_report === true;
  const photos = Math.max(0, Number(row?.report?.photo_count || 0));
  if (physical) {
    return {
      satisfied: submitted && photos >= 5,
      physical,
      submitted,
      photos,
    };
  }
  return {
    satisfied:
      row?.computed_status_evidence?.has_current_portal_capture === true,
    physical,
    submitted,
    photos,
  };
}

function exactTerminalProof(v2Row: any): {
  valid: boolean;
  provenAt: string | null;
} {
  const terminal = v2Row?.state_v2?.terminal_proof;
  return {
    valid: terminal?.state === "valid",
    provenAt: terminal?.state === "valid" ? terminal?.proven_at || null : null,
  };
}

function proofOfCancellation(rawJob: RawJob, v2Row: any): boolean {
  const raw = text(rawJob.status).toLowerCase();
  return ["cancelled", "canceled"].includes(raw) ||
    v2Row?.state_v2?.cancellation?.state === "confirmed";
}

function jobIsOperationallyTerminal(rawJob: RawJob): boolean {
  return rawJob.archived === true ||
    TERMINAL_JOB_STATUSES.has(text(rawJob.status).toLowerCase());
}

function pushFinding(
  findings: AuditFinding[],
  jobRef: string,
  claimedStage: SesStage,
  evidenceStage: SesStage,
  code: string,
  severity: AuditFinding["severity"],
  detail: string,
): void {
  if (findings.some((item) => item.code === code)) return;
  findings.push({
    job_ref: jobRef,
    claimed_stage: claimedStage,
    evidence_stage: evidenceStage,
    code,
    severity,
    detail,
  });
}

export function auditJob(input: {
  canonicalRow: any;
  rawJob: RawJob;
  documents: RawDocument[];
  invoices: RawInvoice[];
  packs: RawPack[];
  documentFlags: DocumentFlags;
  swmsRequired: boolean;
  v2Row: any | null;
  generatedAt: string;
}): AuditJobResult {
  const {
    canonicalRow,
    rawJob,
    documents: _documents,
    invoices,
    packs,
    documentFlags,
    swmsRequired,
    v2Row,
    generatedAt,
  } = input;
  const jobRef = text(canonicalRow?.job_number || rawJob.job_number) ||
    "UNKNOWN-JOB-REF";
  const claimedStage = stage(canonicalRow?.canonical_stage);
  const report = reportEvidence(canonicalRow);
  const activeAssignment = (canonicalRow?.assignments || []).some((item: any) =>
    ACTIVE_ASSIGNMENT_STATUSES.has(text(item?.status).toLowerCase())
  );
  const invoice = strongestInvoice(invoices);
  const invoiceStatus = text(invoice?.status).toUpperCase();
  const candidates = mainPacks(packs);
  const sent = canonicalRow?.pack?.sent === true ||
    SENT_PACK_STATUSES.has(text(canonicalRow?.pack?.state).toLowerCase()) ||
    candidates.some((pack) =>
      SENT_PACK_STATUSES.has(text(pack.status).toLowerCase())
    );
  const exactTerminal = exactTerminalProof(v2Row);
  const documentFallback = sent &&
    ISSUED_INVOICE_STATUSES.has(invoiceStatus) &&
    documentFlags.has_invoice_doc &&
    (!report.physical || documentFlags.has_report_doc) &&
    (!swmsRequired || documentFlags.has_swms_doc) &&
    (report.physical || report.satisfied);
  const compatibilityTerminal = sent &&
    DURABLE_INVOICE_STATUSES.has(invoiceStatus);
  const terminalProven = exactTerminal.valid || compatibilityTerminal ||
    documentFallback;
  const terminalAt = exactTerminal.provenAt ||
    candidates.map((pack) => pack.sent_at).find(Boolean) ||
    invoice?.invoice_date || invoice?.created_at ||
    rawJob.completed_at || rawJob.updated_at || null;

  const legacyDocsReady = report.satisfied &&
    candidates.some((pack) => {
      const packStatus = text(pack.status).toLowerCase();
      return !SENT_PACK_STATUSES.has(packStatus) &&
        invoiceStatus === "DRAFT" &&
        !!pack.invoice_doc_id &&
        (!report.physical || !!pack.report_doc_id) &&
        (!swmsRequired || !!pack.swms_doc_id);
    });
  const docsReady = canonicalRow?.pack?.pre_xero_docs_ready === true ||
    ["READY", "READY_TO_BUILD"].includes(
      text(canonicalRow?.pack?.review_state).toUpperCase(),
    ) ||
    legacyDocsReady;
  const cancelled = proofOfCancellation(rawJob, v2Row);

  let evidenceStage: SesStage = "new";
  if (cancelled) {
    evidenceStage = "cancelled";
  } else if (terminalProven) {
    evidenceStage = isWithinSevenDays(terminalAt, generatedAt)
      ? "completed"
      : "archive";
  } else if (docsReady) {
    evidenceStage = "report_ready";
  } else if (report.satisfied) {
    evidenceStage = "trade_report_in";
  } else if (activeAssignment) {
    evidenceStage = "allocated";
  }

  const findings: AuditFinding[] = [];
  if (claimedStage !== evidenceStage) {
    let direction = "stage_disagrees_with_evidence";
    if (claimedStage === "cancelled" || evidenceStage === "cancelled") {
      direction = "cancellation_stage_disagreement";
    } else if (
      (STAGE_RANK[claimedStage] ?? -1) >
        (STAGE_RANK[evidenceStage] ?? -1)
    ) {
      direction = "stage_ahead_of_evidence";
    } else {
      direction = "stage_behind_evidence";
    }
    pushFinding(
      findings,
      jobRef,
      claimedStage,
      evidenceStage,
      direction,
      "error",
      `Board claims ${claimedStage}; cited evidence rules derive ${evidenceStage}.`,
    );
  }

  const claimedRank = STAGE_RANK[claimedStage] ?? -1;
  if (claimedStage !== "cancelled" && claimedRank >= STAGE_RANK.allocated) {
    if (!activeAssignment && claimedRank < STAGE_RANK.completed) {
      pushFinding(
        findings,
        jobRef,
        claimedStage,
        evidenceStage,
        "missing_active_assignment",
        "error",
        "Stage is Allocated or later but no active current-cycle assignment is present.",
      );
    }
  }
  if (
    claimedStage !== "cancelled" &&
    claimedRank >= STAGE_RANK.trade_report_in && !report.satisfied &&
    !terminalProven
  ) {
    if (report.physical && !report.submitted) {
      pushFinding(
        findings,
        jobRef,
        claimedStage,
        evidenceStage,
        "missing_current_cycle_report",
        "error",
        "Physical work lacks a submitted/approved current-cycle service report.",
      );
    }
    if (report.physical && report.photos < 5) {
      pushFinding(
        findings,
        jobRef,
        claimedStage,
        evidenceStage,
        "missing_completion_photos",
        "error",
        `Physical work has ${report.photos} current-cycle completion photos; five are required.`,
      );
    }
    if (!report.physical) {
      pushFinding(
        findings,
        jobRef,
        claimedStage,
        evidenceStage,
        "missing_portal_or_document_evidence",
        "error",
        "Portal/report-family evidence does not satisfy every required typed role.",
      );
    }
  }
  if (
    claimedStage !== "cancelled" &&
    claimedRank >= STAGE_RANK.report_ready &&
    claimedRank < STAGE_RANK.completed &&
    !docsReady
  ) {
    pushFinding(
      findings,
      jobRef,
      claimedStage,
      evidenceStage,
      "missing_docs_ready_pack",
      "error",
      "Docs Ready is claimed without a current ready decision or qualifying unsent draft pack.",
    );
  }

  const rawStatus = text(rawJob.status).toLowerCase();
  if (rawStatus === "invoiced" && !invoice) {
    pushFinding(
      findings,
      jobRef,
      claimedStage,
      evidenceStage,
      "invoiced_state_without_invoice",
      "critical",
      "Raw job state is invoiced but no linked live ACCREC invoice exists.",
    );
  }

  if (["completed", "archive"].includes(claimedStage)) {
    if (!terminalProven) {
      pushFinding(
        findings,
        jobRef,
        claimedStage,
        evidenceStage,
        "missing_terminal_evidence",
        "critical",
        "Completed/Archive is claimed without exact terminal proof or the compatibility sent-pack plus invoice proof.",
      );
    }
    if (!jobIsOperationallyTerminal(rawJob)) {
      pushFinding(
        findings,
        jobRef,
        claimedStage,
        evidenceStage,
        "display_terminal_operationally_open",
        "critical",
        `Display is ${claimedStage}, but raw job state ${
          rawStatus || "(blank)"
        } is still operationally open.`,
      );
    }
    const missingDocs = [
      !documentFlags.has_invoice_doc ? "invoice" : null,
      report.physical && !documentFlags.has_report_doc ? "report" : null,
      swmsRequired && !documentFlags.has_swms_doc ? "swms" : null,
    ].filter(Boolean);
    if (missingDocs.length > 0) {
      pushFinding(
        findings,
        jobRef,
        claimedStage,
        evidenceStage,
        "terminal_pack_document_gap",
        "warning",
        `Terminal card is missing attached close-out document(s): ${
          missingDocs.join(", ")
        }.`,
      );
    }
  }

  if (claimedStage === "cancelled" && !cancelled) {
    pushFinding(
      findings,
      jobRef,
      claimedStage,
      evidenceStage,
      "cancelled_without_cancellation_proof",
      "critical",
      "Cancelled is displayed without a cancelled raw job state or confirmed v2 cancellation decision.",
    );
  }

  return {
    job_ref: jobRef,
    claimed_stage: claimedStage,
    evidence_stage: evidenceStage,
    report_in: report.satisfied,
    docs_ready: docsReady,
    terminal_proven: terminalProven,
    findings,
  };
}

export function buildAudit(input: AuditInput): AuditResult {
  const rawById = new Map(input.rawJobs.map((job) => [text(job.id), job]));
  const canonicalById = new Map(
    input.canonicalRows.map((row) => [text(row?.id), row]),
  );
  const docsByJob = groupByJob(input.documents);
  const invoicesByJob = groupByJob(input.invoices);
  const packsByJob = groupByJob(input.packs);
  const expectedIds = [...rawById.keys()].filter(Boolean).sort();
  const boardIds = [...canonicalById.keys()].filter(Boolean).sort();
  const coverageMissing = expectedIds.filter((id) => !canonicalById.has(id));
  const coverageExtra = boardIds.filter((id) => !rawById.has(id));
  const jobs: AuditJobResult[] = [];

  for (const jobId of boardIds) {
    const canonicalRow = canonicalById.get(jobId);
    const rawJob = rawById.get(jobId);
    if (!canonicalRow || !rawJob) continue;
    jobs.push(auditJob({
      canonicalRow,
      rawJob,
      documents: docsByJob.get(jobId) || [],
      invoices: invoicesByJob.get(jobId) || [],
      packs: packsByJob.get(jobId) || [],
      documentFlags: input.documentFlagsByJob.get(jobId) || {
        has_invoice_doc: false,
        has_report_doc: false,
        has_swms_doc: false,
      },
      swmsRequired: input.swmsRequiredJobIds.has(jobId),
      v2Row: input.v2RowsByJob.get(jobId) || null,
      generatedAt: input.generatedAt,
    }));
  }

  const allFindings = jobs.flatMap((job) => job.findings);
  if (coverageMissing.length) {
    for (const jobId of coverageMissing) {
      const jobRef = text(rawById.get(jobId)?.job_number) || "UNKNOWN-JOB-REF";
      allFindings.push({
        job_ref: jobRef,
        claimed_stage: "new",
        evidence_stage: "new",
        code: "coverage_missing_from_canonical_board",
        severity: "critical",
        detail:
          "Paged board population contains a job omitted by the canonical board loader.",
      });
    }
  }
  if (coverageExtra.length) {
    for (const jobId of coverageExtra) {
      const jobRef = text(canonicalById.get(jobId)?.job_number) ||
        "UNKNOWN-JOB-REF";
      allFindings.push({
        job_ref: jobRef,
        claimed_stage: stage(canonicalById.get(jobId)?.canonical_stage),
        evidence_stage: "new",
        code: "coverage_extra_on_canonical_board",
        severity: "critical",
        detail:
          "Canonical board contains a job outside the independently paged board population.",
      });
    }
  }

  const v2Blockers: string[] = [];
  const v2Diagnostics: string[] = [];
  for (const row of input.v2RowsByJob.values()) {
    for (const blocker of row?.state_v2?.blocker?.active || []) {
      if (blocker?.code) v2Blockers.push(String(blocker.code));
    }
    for (const diagnostic of row?.state_v2?.diagnostics || []) {
      if (diagnostic?.code) v2Diagnostics.push(String(diagnostic.code));
    }
  }

  return {
    generated_at: input.generatedAt,
    population_count: input.rawJobs.length,
    canonical_board_count: input.canonicalRows.length,
    coverage_missing_from_board: coverageMissing.map((id) =>
      text(rawById.get(id)?.job_number) || "UNKNOWN-JOB-REF"
    ),
    coverage_extra_on_board: coverageExtra.map((id) =>
      text(canonicalById.get(id)?.job_number) || "UNKNOWN-JOB-REF"
    ),
    claimed_stage_counts: countBy(jobs.map((job) => job.claimed_stage)),
    evidence_stage_counts: countBy(jobs.map((job) => job.evidence_stage)),
    failure_counts: countBy(allFindings.map((item) => item.code)),
    severity_counts: countBy(allFindings.map((item) => item.severity)),
    v2_blocker_counts: countBy(v2Blockers),
    v2_diagnostic_counts: countBy(v2Diagnostics),
    projection_health: input.projectionHealth,
    v2_load_error: input.v2LoadError,
    page_stats: input.pageStats,
    jobs,
  };
}

export function assertReadOnlyRequest(init: RequestInit = {}): void {
  const method = String(init.method || "GET").toUpperCase();
  if (!["GET", "HEAD"].includes(method)) {
    throw new Error(
      `SES evidence-stage checker forbids production mutation method ${method}`,
    );
  }
}

export async function readOnlyFetch(
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  const method = init.method ||
    (input instanceof Request ? input.method : "GET");
  assertReadOnlyRequest({ ...init, method });
  return await fetch(input, { ...init, method: method || "GET" });
}

function chunks<T>(values: readonly T[], size = IN_CHUNK_SIZE): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push([...values.slice(index, index + size)]);
  }
  return result;
}

export async function fetchAllPages<T>(
  label: string,
  makeQuery: () => any,
  pageStats: Record<string, { pages: number; rows: number }>,
): Promise<T[]> {
  const rows: T[] = [];
  let pages = 0;
  for (let offset = 0; offset < 1_000_000; offset += PAGE_SIZE) {
    const { data, error } = await makeQuery().range(
      offset,
      offset + PAGE_SIZE - 1,
    );
    if (error) {
      throw new Error(`${label} page ${pages + 1} failed: ${error.message}`);
    }
    const batch = (data || []) as T[];
    rows.push(...batch);
    pages += 1;
    if (batch.length < PAGE_SIZE) break;
  }
  pageStats[label] = { pages, rows: rows.length };
  return rows;
}

async function fetchByJobIdChunks<T>(
  client: any,
  table: string,
  select: string,
  jobIds: string[],
  pageStats: Record<string, { pages: number; rows: number }>,
  configure?: (query: any) => any,
): Promise<T[]> {
  const rows: T[] = [];
  let totalPages = 0;
  for (const [chunkIndex, jobIdChunk] of chunks(jobIds).entries()) {
    const label = `${table} chunk ${chunkIndex + 1}`;
    const chunkRows = await fetchAllPages<T>(
      label,
      () => {
        let query = client.from(table).select(select).in("job_id", jobIdChunk);
        if (configure) query = configure(query);
        return query.order("id", { ascending: true });
      },
      pageStats,
    );
    totalPages += pageStats[label].pages;
    rows.push(...chunkRows);
    delete pageStats[label];
  }
  pageStats[table] = { pages: totalPages, rows: rows.length };
  return rows;
}

async function loadPagedBoardPopulation(
  client: any,
  pageStats: Record<string, { pages: number; rows: number }>,
): Promise<PagedBoardPopulation> {
  const select =
    "id,job_number,type,status,archived,created_at,updated_at,completed_at,insurance_job_type:metadata->>insurance_job_type,synthetic_livefire_marker:metadata->>synthetic_livefire_marker";
  const rows: RawJob[] = [];
  for (
    const source of [
      { type: "makesafe", insuranceJobType: null },
      { type: "insurance", insuranceJobType: "restoration" },
    ]
  ) {
    for (const statusGroup of ["active", "cancelled"] as const) {
      const label = `jobs ${source.type} ${statusGroup}`;
      rows.push(
        ...await fetchAllPages<RawJob>(
          label,
          () => {
            let query = client.from("jobs").select(select).eq(
              "type",
              source.type,
            );
            if (source.insuranceJobType) {
              query = query.eq(
                "metadata->>insurance_job_type",
                source.insuranceJobType,
              );
            }
            query = statusGroup === "cancelled"
              ? query.eq("status", "cancelled")
              : query.not("status", "in", '("cancelled","lost")');
            return query.order("created_at", { ascending: false })
              .order("id", { ascending: false });
          },
          pageStats,
        ),
      );
    }
  }

  const terminalRuns = await fetchAllPages<
    { marker: string; job_ids: unknown }
  >(
    "terminal synthetic livefire runs",
    () =>
      client.from("ses_synthetic_livefire_runs").select("marker,job_ids")
        .eq("state", "terminal").order("marker", { ascending: true }),
    pageStats,
  );
  const terminalIds = new Set(
    terminalRuns.flatMap((run) =>
      Array.isArray(run.job_ids) ? run.job_ids.map(String) : []
    ),
  );
  return {
    rows: [...new Map(rows.map((row) => [text(row.id), row])).values()]
      .filter((row) => !terminalIds.has(text(row.id)))
      .sort((a, b) =>
        text(b.created_at).localeCompare(text(a.created_at)) ||
        text(b.id).localeCompare(text(a.id))
      ),
    terminalSyntheticJobIds: terminalIds,
  };
}

export function filterCanonicalRowsForAudit(
  canonicalRows: any[],
  terminalSyntheticJobIds: Set<string>,
): any[] {
  return canonicalRows.filter((row) =>
    !terminalSyntheticJobIds.has(text(row?.id))
  );
}

function requiredEnv(name: string, fallback?: string): string {
  const value = text(Deno.env.get(name) || fallback);
  if (!value) throw new Error(`${name} is required`);
  return value.replace(/\/+$/, "");
}

function option(name: string, fallback?: string): string | undefined {
  const withEquals = Deno.args.find((arg) => arg.startsWith(`${name}=`));
  if (withEquals) return withEquals.slice(name.length + 1);
  const index = Deno.args.indexOf(name);
  return index >= 0 ? Deno.args[index + 1] : fallback;
}

function escapeCell(value: unknown): string {
  return text(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function table(
  headers: string[],
  rows: Array<Array<string | number>>,
): string {
  if (rows.length === 0) return "_None._\n";
  return [
    `| ${headers.map(escapeCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`),
    "",
  ].join("\n");
}

function worstOffenders(result: AuditResult, limit = 25): AuditJobResult[] {
  const weights: Record<string, number> = {
    display_terminal_operationally_open: 100,
    invoiced_state_without_invoice: 90,
    missing_terminal_evidence: 80,
    stage_ahead_of_evidence: 70,
    cancelled_without_cancellation_proof: 65,
    stage_behind_evidence: 50,
    missing_docs_ready_pack: 40,
    missing_current_cycle_report: 35,
    missing_completion_photos: 30,
    missing_active_assignment: 25,
    terminal_pack_document_gap: 10,
  };
  return result.jobs
    .filter((job) => job.findings.length > 0)
    .sort((a, b) => {
      const score = (job: AuditJobResult) =>
        job.findings.reduce(
          (sum, finding) => sum + (weights[finding.code] || 5),
          0,
        );
      return score(b) - score(a) ||
        b.findings.length - a.findings.length ||
        a.job_ref.localeCompare(b.job_ref);
    })
    .slice(0, limit);
}

function reconciliationWorklist(result: AuditResult): AuditJobResult[] {
  const coverageFindings: AuditJobResult[] = [
    ...result.coverage_missing_from_board.map((jobRef) => ({
      job_ref: jobRef,
      claimed_stage: "new" as SesStage,
      evidence_stage: "new" as SesStage,
      report_in: false,
      docs_ready: false,
      terminal_proven: false,
      findings: [{
        job_ref: jobRef,
        claimed_stage: "new" as SesStage,
        evidence_stage: "new" as SesStage,
        code: "coverage_missing_from_canonical_board",
        severity: "critical" as const,
        detail:
          "Paged board population contains a job omitted by the canonical board loader.",
      }],
    })),
    ...result.coverage_extra_on_board.map((jobRef) => ({
      job_ref: jobRef,
      claimed_stage: "new" as SesStage,
      evidence_stage: "new" as SesStage,
      report_in: false,
      docs_ready: false,
      terminal_proven: false,
      findings: [{
        job_ref: jobRef,
        claimed_stage: "new" as SesStage,
        evidence_stage: "new" as SesStage,
        code: "coverage_extra_on_canonical_board",
        severity: "critical" as const,
        detail:
          "Canonical board contains a job outside the independently paged board population.",
      }],
    })),
  ];
  return [...worstOffenders(result, result.jobs.length), ...coverageFindings];
}

function rerunCommand(outputPath: string): string {
  return [
    `SUPABASE_URL='${DEFAULT_SUPABASE_URL}' \\`,
    `SUPABASE_SERVICE_ROLE_KEY="$(supabase projects api-keys --project-ref ${PROJECT_REF} -o json | jq -er '.[] | select(.name == "service_role") | .api_key')" \\`,
    `/Users/marninstobbe/.deno/bin/deno run --allow-env --allow-net --allow-read --allow-write='${outputPath}' \\`,
    `scripts/ses-evidence-stage-checker.ts --output '${outputPath}'`,
  ].join("\n");
}

export function renderMarkdown(
  result: AuditResult,
  outputPath: string,
): string {
  const failures = Object.entries(result.failure_counts);
  const worklist = reconciliationWorklist(result);
  const offenders = worklist.slice(0, 25);
  const cardsWithFindings =
    result.jobs.filter((job) => job.findings.length > 0).length;
  const stageMismatchCount =
    result.jobs.filter((job) => job.claimed_stage !== job.evidence_stage)
      .length;
  const projectionErrors =
    result.projection_health?.projection_input_error_job_count ?? null;
  const v2Usable = result.v2_load_error === null &&
    result.projection_health?.complete === true &&
    projectionErrors === 0;
  const conclusion = v2Usable
    ? "The v2 evidence authority was complete for this run."
    : "The v2 authority was not usable as final truth for this run; the per-card list below is a provisional compatibility-evidence work-list and the systemic v2 input failures must be repaired first.";

  const markdown = `# SES evidence-and-stage checker v1

Generated: ${result.generated_at}

## Captain summary

- Audited **${result.canonical_board_count}** canonical live-board cards against an independently paged population of **${result.population_count}** jobs.
- **${stageMismatchCount}** cards claim a different stage from the stage supported by the cited evidence rules.
- **${cardsWithFindings}** cards have at least one evidence, stage, operational-state, or close-out-document finding.
- Coverage reconciliation: **${result.coverage_missing_from_board.length}** expected jobs missing from the canonical board; **${result.coverage_extra_on_board.length}** unexpected canonical rows.
- v2 comparison: ${
    result.v2_load_error
      ? `unavailable (${result.v2_load_error})`
      : `${result.projection_health?.projected_job_count ?? 0} projected; ${
        projectionErrors ?? "unknown"
      } projection-input errors`
  }.

${conclusion}

This checker did not move a stage, mutate a job, write a note, send a notification, or contact a client. Its production transport rejects every HTTP method except GET/HEAD.

## Failure counts

${
    table(
      ["Failure type", "Cards"],
      failures.map(([code, count]) => [code, count]),
    )
  }
## Claimed stage versus evidence stage

${
    table(
      ["Stage", "Claimed", "Evidence-derived"],
      [
        ...new Set([
          ...Object.keys(result.claimed_stage_counts),
          ...Object.keys(result.evidence_stage_counts),
        ]),
      ].sort((a, b) => (STAGE_RANK[a] ?? 99) - (STAGE_RANK[b] ?? 99)).map((
        name,
      ) => [
        name,
        result.claimed_stage_counts[name] || 0,
        result.evidence_stage_counts[name] || 0,
      ]),
    )
  }
## Worst offenders

Ranked by unsafe terminal display, missing linked invoice/terminal proof, then stage distance and missing prerequisites. Job/work-order references only.

  ${
    table(
      ["Job ref", "Claimed", "Evidence", "Failure codes"],
      offenders.map((job) => [
        job.job_ref,
        job.claimed_stage,
        job.evidence_stage,
        job.findings.map((finding) => finding.code).join(", "),
      ]),
    )
  }
## Complete reconciliation work-list

All **${worklist.length}** cards with findings, in the same risk-first order. This is the re-runnable handoff list for board reconciliation.

${
    table(
      ["Job ref", "Claimed", "Evidence", "Failure codes"],
      worklist.map((job) => [
        job.job_ref,
        job.claimed_stage,
        job.evidence_stage,
        job.findings.map((finding) => finding.code).join(", "),
      ]),
    )
  }
## Re-run

Run from the repository root:

\`\`\`bash
${rerunCommand(outputPath)}
\`\`\`

The command resolves the existing service-role key locally and never prints it. The report contains no client name, address, phone or email fields.

## Recommendation

1. Repair the systemic v2 projection-input failures before treating any automatic board move as authoritative.
2. Use the ranked per-card work-list to reconcile unsafe terminal overlays and raw invoiced states first.
3. Re-run this checker after the historical PDF drain settles. Compare the failure-count table and job-ref list, not a cached dashboard screenshot.
4. Keep terminal disagreements review-only until exact-cycle proof or the documented compatibility close-out evidence is present.

## Technical appendix

### Rule table

${
    table(
      ["Claim/rule", "Evidence required", "Code source"],
      RULES.map((rule) => [rule.stage, rule.requirement, rule.source]),
    )
  }
### v2 authority health

${
    table(
      ["Metric", "Value"],
      [
        ["complete", String(result.projection_health?.complete ?? false)],
        [
          "requested jobs",
          String(result.projection_health?.requested_job_count ?? "n/a"),
        ],
        [
          "projected jobs",
          String(result.projection_health?.projected_job_count ?? "n/a"),
        ],
        [
          "v1/v2 differing jobs",
          String(result.projection_health?.differing_job_count ?? "n/a"),
        ],
        [
          "projection-input-error jobs",
          String(
            result.projection_health?.projection_input_error_job_count ?? "n/a",
          ),
        ],
        ["load error", result.v2_load_error || "none"],
      ],
    )
  }
### v2 blocker counts

${
    table(
      ["Blocker code", "Cards"],
      Object.entries(result.v2_blocker_counts).map(([code, count]) => [
        code,
        count,
      ]),
    )
  }
### v2 diagnostic counts

${
    table(
      ["Diagnostic code", "Cards"],
      Object.entries(result.v2_diagnostic_counts).map(([code, count]) => [
        code,
        count,
      ]),
    )
  }
### Pagination evidence

Every table below was read through a \`.range(offset, offset + 999)\` loop; job-id dependent reads were additionally chunked to keep PostgREST URLs bounded.

${
    table(
      ["Read", "Pages", "Rows"],
      Object.entries(result.page_stats).map(([label, stats]) => [
        label,
        stats.pages,
        stats.rows,
      ]),
    )
  }
### Severity counts

${
    table(
      ["Severity", "Findings"],
      Object.entries(result.severity_counts).map(([severity, count]) => [
        severity,
        count,
      ]),
    )
  }
### Privacy and limitations

- The live canonical rows necessarily contain operational contact fields in memory, but the report model accepts only job/work-order reference, stage, failure code and aggregate counts.
- No client names, addresses, phones or emails are serialized.
- A v2 projection-input error means exact cycle/identity authority is indeterminate. Compatibility evidence remains useful for a work-list, but it is not permission to mutate a stage.
- Missing attached documents on a durably sent, issued/paid compatibility close-out are reported as warnings because the compatibility status code accepts that terminal proof while still surfacing the document gap.
`;
  assertReportPrivacy(markdown);
  return markdown;
}

export function assertReportPrivacy(markdown: string): void {
  const forbidden = [
    /\bclient_(?:name|phone|email)\b/i,
    /\bsite_(?:address|suburb)\b/i,
    /\bcontact\.(?:phone|client_name|address)\b/i,
    /\b04\d{2}[\s-]?\d{3}[\s-]?\d{3}\b/,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  ];
  const match = forbidden.find((pattern) => pattern.test(markdown));
  if (match) {
    throw new Error(
      `Report privacy guard rejected personal-data-shaped output (${match})`,
    );
  }
}

async function run(): Promise<void> {
  const supabaseUrl = requiredEnv("SUPABASE_URL", DEFAULT_SUPABASE_URL);
  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const outputPath = option("--output");
  if (!outputPath) throw new Error("--output is required");
  const generatedAt = new Date().toISOString();
  const pageStats: Record<string, { pages: number; rows: number }> = {};

  const supabaseModuleUrl = "https://esm.sh/@supabase/supabase-js@2";
  const { createClient } = await import(supabaseModuleUrl);
  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: readOnlyFetch },
  });
  const opsModuleUrl = new URL(
    "../supabase/functions/ops-api/index.ts",
    import.meta.url,
  ).href;
  const opsModule = await import(opsModuleUrl);
  const compareModule = await import(
    "../supabase/functions/ops-api/makesafe_state_compare.ts"
  );

  const [population, importedCanonicalRows] = await Promise.all([
    loadPagedBoardPopulation(client, pageStats),
    opsModule._loadCanonicalMakesafeBoardForTest(client),
  ]);
  const rawJobs = population.rows;
  const canonicalRows = filterCanonicalRowsForAudit(
    importedCanonicalRows,
    population.terminalSyntheticJobIds,
  );
  const jobIds = rawJobs.map((job) => text(job.id)).filter(Boolean);
  const [documents, invoices, packs] = await Promise.all([
    fetchByJobIdChunks<RawDocument>(
      client,
      "job_documents",
      "id,job_id,type,file_name",
      jobIds,
      pageStats,
    ),
    fetchByJobIdChunks<RawInvoice>(
      client,
      "xero_invoices",
      "id,job_id,status,invoice_type,invoice_date,created_at",
      jobIds,
      pageStats,
      (query) => query.eq("invoice_type", "ACCREC"),
    ),
    fetchByJobIdChunks<RawPack>(
      client,
      "makesafe_report_packs",
      "id,job_id,pack_kind,status,review_state,report_doc_id,invoice_doc_id,swms_doc_id,sent_at",
      jobIds,
      pageStats,
    ),
  ]);

  let projectionHealth: ProjectionHealth | null = null;
  let v2LoadError: string | null = null;
  let comparedRows: any[] = [];
  try {
    const comparison = await compareModule
      .attachMakesafeStateV2SeedPreviewComparison(
        client,
        canonicalRows,
        generatedAt,
      );
    projectionHealth = comparison.projection_health;
    comparedRows = comparison.rows;
  } catch (error) {
    v2LoadError = error instanceof Error ? error.message : String(error);
  }

  const docsByJob = groupByJob(documents);
  const documentFlagsByJob = new Map<string, DocumentFlags>();
  const swmsRequiredJobIds = new Set<string>();
  for (const row of canonicalRows) {
    const jobId = text(row?.id);
    documentFlagsByJob.set(
      jobId,
      opsModule._makesafeDocBooleansForTest(docsByJob.get(jobId) || []),
    );
    const detail = {
      requesting_company_name: row?.builder?.name || null,
      external_ref: row?.builder?.external_ref || null,
    };
    if (
      opsModule._isMakesafeMlbCompany(detail, row) ||
      opsModule._isMakesafeWesternCompany(detail, row)
    ) {
      swmsRequiredJobIds.add(jobId);
    }
  }

  const result = buildAudit({
    canonicalRows,
    rawJobs,
    documents,
    invoices,
    packs,
    documentFlagsByJob,
    swmsRequiredJobIds,
    v2RowsByJob: new Map(
      comparedRows.map((row) => [text(row?.id), row]),
    ),
    projectionHealth,
    v2LoadError,
    generatedAt,
    pageStats,
  });
  const markdown = renderMarkdown(result, outputPath);
  await Deno.writeTextFile(outputPath, markdown);
  console.log(JSON.stringify({
    output: outputPath,
    population: result.population_count,
    canonical_board: result.canonical_board_count,
    cards_with_findings: result.jobs.filter((job) => job.findings.length > 0)
      .length,
    stage_mismatches: result.jobs.filter((job) =>
      job.claimed_stage !== job.evidence_stage
    ).length,
    failure_counts: result.failure_counts,
    projection_health: result.projection_health,
  }));
}

if (import.meta.main) {
  await run();
}
