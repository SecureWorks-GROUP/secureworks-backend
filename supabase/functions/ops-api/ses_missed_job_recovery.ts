export const SES_MISSED_JOB_RULING_DATE = "2026-08-01";
export const SES_MISSED_JOB_ADJUDICATION_REF =
  "data/ses-shadow-adjudicate-v1/report.md#6.1";
export const MLB_27309_SOURCE_POST_ID =
  "AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAAvuZ4kAAA=";
export const BWCWA_6648_SOURCE_POST_ID =
  "AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAAXeAaSAAA=";

export class SesMissedJobRecoveryError extends Error {
  readonly status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.name = "SesMissedJobRecoveryError";
    this.status = status;
  }
}

export interface ExactRescanInput {
  post_id: string;
  expected_job_family: string;
}

export interface ExactRescanAuthority {
  caseId: string;
  state: string;
  jobId: string | null;
  targetJobId: string | null;
}

export interface ExactRescanJob {
  id: string;
  jobNumber: string;
  jobFamily: string;
  attendance?: {
    currentAttendanceCycleId: string | null;
    immutableAttendanceCycleIds: string[];
    attribution: string | null;
    cycleNumber: number;
  };
}

export interface ExactRescanDependencies {
  loadAuthority(postId: string): Promise<ExactRescanAuthority>;
  scan(postId: string): Promise<unknown>;
  loadJob(caseId: string): Promise<ExactRescanJob | null>;
  appendProvenance(args: {
    postId: string;
    authority: ExactRescanAuthority;
    job: ExactRescanJob;
  }): Promise<void>;
  hasProvenance(args: {
    postId: string;
    caseId: string;
    jobId: string;
  }): Promise<boolean>;
  canRepairProvenance(args: {
    postId: string;
    caseId: string;
    jobId: string;
  }): Promise<boolean>;
}

function exactString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new SesMissedJobRecoveryError(
      `${label} must be one non-empty exact string`,
      400,
    );
  }
  return value;
}

function assertExactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SesMissedJobRecoveryError(`${label} must be a JSON object`, 400);
  }
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new SesMissedJobRecoveryError(
      `${label} must contain exactly: ${wanted.join(", ")}`,
      400,
    );
  }
}

function assertExpectedFamily(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new SesMissedJobRecoveryError(
      `exact rescan minted unexpected family ${
        actual || "<missing>"
      }; expected ${expected}`,
    );
  }
}

function assertRoofAttendanceCycle(
  job: ExactRescanJob,
  newlyMinted: boolean,
): void {
  if (job.jobFamily !== "roof_report") return;
  const attendance = job.attendance;
  const current = attendance?.currentAttendanceCycleId || "";
  const immutable = attendance?.immutableAttendanceCycleIds || [];
  if (
    attendance?.attribution !== "bound" || !current ||
    !immutable.includes(current)
  ) {
    throw new SesMissedJobRecoveryError(
      "exact rescan roof-report postcondition failed: current attendance cycle is not bound inside the immutable cycle set",
      503,
    );
  }
  if (
    newlyMinted &&
    (attendance.cycleNumber !== 1 || immutable.length !== 1)
  ) {
    throw new SesMissedJobRecoveryError(
      "exact rescan roof-report postcondition failed: a new job must have exactly one initial attendance cycle",
      503,
    );
  }
}

export async function runAdjudicatedExactRescan(
  input: ExactRescanInput,
  deps: ExactRescanDependencies,
): Promise<Record<string, unknown>> {
  assertExactKeys(
    input,
    ["post_id", "expected_job_family"],
    "exact rescan body",
  );
  const postId = exactString(input?.post_id, "post_id");
  const expectedFamily = exactString(
    input?.expected_job_family,
    "expected_job_family",
  );
  if (postId !== MLB_27309_SOURCE_POST_ID || expectedFamily !== "roof_report") {
    throw new SesMissedJobRecoveryError(
      "exact rescan refused: this captain ruling authorizes only MLB-27309 as roof_report",
    );
  }
  const authority = await deps.loadAuthority(postId);

  if (authority.targetJobId) {
    throw new SesMissedJobRecoveryError(
      "exact rescan refused: source already has a corrected target job binding",
    );
  }

  if (authority.jobId) {
    const existing = await deps.loadJob(authority.caseId);
    if (!existing || existing.id !== authority.jobId) {
      throw new SesMissedJobRecoveryError(
        "exact rescan refused: prior job fate cannot be resolved",
      );
    }
    assertExpectedFamily(existing.jobFamily, expectedFamily);
    assertRoofAttendanceCycle(existing, false);
    const provenanceArgs = {
      postId,
      caseId: authority.caseId,
      jobId: existing.id,
    };
    if (!(await deps.hasProvenance(provenanceArgs))) {
      if (!(await deps.canRepairProvenance(provenanceArgs))) {
        throw new SesMissedJobRecoveryError(
          "exact rescan refused: source already has a job without a settled deterministic mint and accepted Hugo notification",
        );
      }
      await deps.appendProvenance({ postId, authority, job: existing });
      if (!(await deps.hasProvenance(provenanceArgs))) {
        throw new SesMissedJobRecoveryError(
          "exact rescan provenance repair did not settle",
          503,
        );
      }
    }
    return {
      ok: true,
      outcome: "already_completed",
      post_id: postId,
      case_id: authority.caseId,
      job_id: existing.id,
      job_number: existing.jobNumber,
      job_family: existing.jobFamily,
    };
  }

  if (authority.state !== "exception") {
    throw new SesMissedJobRecoveryError(
      `exact rescan refused: prior no-job fate ${
        authority.state || "<missing>"
      } is not eligible`,
    );
  }

  const report = await deps.scan(postId);
  const job = await deps.loadJob(authority.caseId);
  if (!job) {
    throw new SesMissedJobRecoveryError(
      "exact rescan completed without a linked live job",
      503,
    );
  }
  assertExpectedFamily(job.jobFamily, expectedFamily);
  assertRoofAttendanceCycle(job, true);
  await deps.appendProvenance({ postId, authority, job });

  return {
    ok: true,
    outcome: "minted",
    post_id: postId,
    case_id: authority.caseId,
    job_id: job.id,
    job_number: job.jobNumber,
    job_family: job.jobFamily,
    deterministic_report: report,
  };
}

export interface HistoricalBackfillInput {
  post_id: string;
  invoice_number: string;
  external_ref: string;
  invoice_date: string;
  requesting_company_slug: string;
  expected_job_family: string;
}

export interface HistoricalBackfillAuthority {
  caseId: string;
  state: string;
  jobId: string | null;
  targetJobId: string | null;
  sourcePostIds: string[];
  sourceCorrections: Array<{
    correctionKind: string;
    targetJobId: string | null;
  }>;
  fromEmail: string;
  subject: string;
}

export interface HistoricalBackfillInvoice {
  xeroInvoiceId: string;
  invoiceNumber: string;
  invoiceDate: string;
  invoiceType: string;
  status: string;
  reference: string;
  contactName: string;
  jobId: string | null;
  lineItems: unknown;
}

export interface HistoricalBackfillJob extends ExactRescanJob {}

export interface HistoricalBackfillDependencies {
  loadAuthority(postId: string): Promise<HistoricalBackfillAuthority>;
  loadInvoice(invoiceNumber: string): Promise<HistoricalBackfillInvoice | null>;
  loadExistingJob(recoveryKey: string): Promise<HistoricalBackfillJob | null>;
  createJob(args: {
    recoveryKey: string;
    externalRef: string;
    requestingCompanySlug: string;
    jobFamily: string;
    invoiceNumber: string;
  }): Promise<HistoricalBackfillJob>;
  ensureJobCard(args: {
    job: HistoricalBackfillJob;
    externalRef: string;
    requestingCompanySlug: string;
  }): Promise<void>;
  bindLineage(args: {
    authority: HistoricalBackfillAuthority;
    job: HistoricalBackfillJob;
    expectedIdentityKey: string;
  }): Promise<void>;
  linkInvoice(invoice: HistoricalBackfillInvoice, jobId: string): Promise<void>;
  archiveDisplay(job: HistoricalBackfillJob): Promise<void>;
  appendProvenance(args: {
    authority: HistoricalBackfillAuthority;
    invoice: HistoricalBackfillInvoice;
    job: HistoricalBackfillJob;
    recoveryKey: string;
  }): Promise<void>;
}

function normalized(value: unknown): string {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function validateHistoricalEvidence(
  input: HistoricalBackfillInput,
  authority: HistoricalBackfillAuthority,
  invoice: HistoricalBackfillInvoice | null,
  existingJob: HistoricalBackfillJob | null,
): asserts invoice is HistoricalBackfillInvoice {
  if (!invoice) {
    throw new SesMissedJobRecoveryError(
      "historical backfill refused: exact invoice was not found",
    );
  }
  if (authority.jobId) {
    throw new SesMissedJobRecoveryError(
      "historical backfill refused: source case already produced a job",
    );
  }
  if (authority.state !== "exception") {
    throw new SesMissedJobRecoveryError(
      `historical backfill refused: prior fate ${
        authority.state || "<missing>"
      } is not the authorized exception`,
    );
  }
  if (!authority.sourcePostIds.includes(input.post_id)) {
    throw new SesMissedJobRecoveryError(
      "historical backfill refused: explicit source is outside its lineage closure",
    );
  }
  if (!authority.fromEmail.toLowerCase().endsWith("@primeeco.tech")) {
    throw new SesMissedJobRecoveryError(
      "historical backfill refused: source is not a Prime builder instruction",
    );
  }
  if (!normalized(authority.subject).includes(normalized(input.external_ref))) {
    throw new SesMissedJobRecoveryError(
      "historical backfill refused: source subject does not carry the external reference",
    );
  }
  if (
    input.requesting_company_slug !== "bw" ||
    !normalized(input.external_ref).startsWith("BWCWA") ||
    !normalized(authority.subject).includes("BUILDERWEST") ||
    !normalized(authority.subject).includes("MAKESAFE") ||
    input.expected_job_family !== "general_makesafe"
  ) {
    throw new SesMissedJobRecoveryError(
      "historical backfill refused: source does not prove the Builderwest general make-safe family",
    );
  }
  if (
    invoice.invoiceNumber !== input.invoice_number ||
    invoice.invoiceDate !== input.invoice_date ||
    invoice.invoiceType !== "ACCREC" ||
    ["VOIDED", "DELETED"].includes(invoice.status) ||
    (invoice.jobId !== null && invoice.jobId !== existingJob?.id)
  ) {
    throw new SesMissedJobRecoveryError(
      "historical backfill refused: invoice identity, type, date, status, or link changed",
    );
  }
  const invoiceEvidence = normalized(
    `${invoice.reference} ${invoice.contactName} ${
      JSON.stringify(invoice.lineItems)
    }`,
  );
  if (
    !invoiceEvidence.includes(normalized(input.external_ref)) ||
    !invoiceEvidence.includes("MAKESAFE") ||
    !normalized(invoice.contactName).includes("BUILDERWEST")
  ) {
    throw new SesMissedJobRecoveryError(
      "historical backfill refused: invoice does not prove the named make-safe work",
    );
  }
}

export async function runAdjudicatedHistoricalBackfill(
  input: HistoricalBackfillInput,
  deps: HistoricalBackfillDependencies,
): Promise<Record<string, unknown>> {
  assertExactKeys(
    input,
    [
      "post_id",
      "invoice_number",
      "external_ref",
      "invoice_date",
      "requesting_company_slug",
      "expected_job_family",
    ],
    "historical backfill body",
  );
  const exactInput = {
    post_id: exactString(input?.post_id, "post_id"),
    invoice_number: exactString(input?.invoice_number, "invoice_number"),
    external_ref: exactString(input?.external_ref, "external_ref"),
    invoice_date: exactString(input?.invoice_date, "invoice_date"),
    requesting_company_slug: exactString(
      input?.requesting_company_slug,
      "requesting_company_slug",
    ),
    expected_job_family: exactString(
      input?.expected_job_family,
      "expected_job_family",
    ),
  };
  if (
    exactInput.post_id !== BWCWA_6648_SOURCE_POST_ID ||
    exactInput.invoice_number !== "INV-0754" ||
    exactInput.external_ref !== "BWCWA-6648" ||
    exactInput.invoice_date !== "2026-06-24" ||
    exactInput.requesting_company_slug !== "bw" ||
    exactInput.expected_job_family !== "general_makesafe"
  ) {
    throw new SesMissedJobRecoveryError(
      "historical backfill refused: this captain ruling authorizes only BWCWA-6648 with INV-0754",
    );
  }
  const recoveryKey =
    `ses-historical:${exactInput.external_ref}:${exactInput.invoice_number}`;
  const [authority, invoice, existingJob] = await Promise.all([
    deps.loadAuthority(exactInput.post_id),
    deps.loadInvoice(exactInput.invoice_number),
    deps.loadExistingJob(recoveryKey),
  ]);
  validateHistoricalEvidence(exactInput, authority, invoice, existingJob);

  let job = existingJob;
  const correctionConflict = authority.sourceCorrections.some((correction) =>
    correction.correctionKind !== "existing_job_binding" ||
    correction.targetJobId !== existingJob?.id
  );
  if (
    (authority.targetJobId && authority.targetJobId !== existingJob?.id) ||
    (authority.sourceCorrections.length > 0 &&
      (!existingJob || correctionConflict))
  ) {
    throw new SesMissedJobRecoveryError(
      "historical backfill refused: source already has a conflicting target or authority correction",
    );
  }
  if (!job) {
    job = await deps.createJob({
      recoveryKey,
      externalRef: exactInput.external_ref,
      requestingCompanySlug: exactInput.requesting_company_slug,
      jobFamily: exactInput.expected_job_family,
      invoiceNumber: exactInput.invoice_number,
    });
  }
  assertExpectedFamily(job.jobFamily, exactInput.expected_job_family);
  await deps.ensureJobCard({
    job,
    externalRef: exactInput.external_ref,
    requestingCompanySlug: exactInput.requesting_company_slug,
  });

  await deps.bindLineage({
    authority,
    job,
    expectedIdentityKey: `ref:${exactInput.external_ref}`,
  });
  await deps.linkInvoice(invoice, job.id);
  await deps.archiveDisplay(job);
  await deps.appendProvenance({ authority, invoice, job, recoveryKey });

  return {
    ok: true,
    outcome: "backfilled_archived",
    post_id: exactInput.post_id,
    case_id: authority.caseId,
    source_post_ids: authority.sourcePostIds,
    job_id: job.id,
    job_number: job.jobNumber,
    job_family: job.jobFamily,
    invoice_number: invoice.invoiceNumber,
    xero_invoice_id: invoice.xeroInvoiceId,
    display_stage: "ARCHIVED",
    communications_sent: 0,
  };
}
