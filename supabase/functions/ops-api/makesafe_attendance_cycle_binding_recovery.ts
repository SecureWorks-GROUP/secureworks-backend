import { isMakesafeTerminalJobState } from "./makesafe_status_apply.ts";

export const ROOF_CYCLE_BINDING_RECOVERY_JOB_NUMBERS = [
  "SWMS-261079",
  "SWMS-261113",
  "SWMS-261114",
  "SWMS-261116",
  "SWMS-261123",
] as const;

const AUTHORIZED_JOB_NUMBERS = new Set<string>(
  ROOF_CYCLE_BINDING_RECOVERY_JOB_NUMBERS,
);
export class MakesafeAttendanceCycleBindingRecoveryError extends Error {
  readonly status: number;
  readonly body?: unknown;

  constructor(message: string, status = 409, body?: unknown) {
    super(message);
    this.name = "MakesafeAttendanceCycleBindingRecoveryError";
    this.status = status;
    this.body = body;
  }
}

export interface RoofCycleBindingRecoveryInput {
  job_numbers: string[];
  dry_run?: boolean;
  plan_token?: string | null;
}

export interface RoofCycleBindingRecoverySnapshot {
  job: {
    id: string;
    jobNumber: string;
    type: string;
    status: string;
    family: string;
  } | null;
  detail: {
    jobId: string;
    externalRef: string;
    reportType: string | null;
    cycleNumber: number;
    attendanceCycleId: string | null;
    cycleAttribution: string | null;
  } | null;
  cycles: Array<{
    id: string;
    jobId: string;
    cycleNumber: number;
    openReason: string | null;
  }>;
  intakeCases: Array<{
    id: string;
    state: string;
    jobId: string | null;
    targetJobId: string | null;
    instructionKey: string | null;
    builderWorkOrder: string | null;
    builderPurchaseOrder: string | null;
    externalRef: string | null;
  }>;
  evidenceCounts: {
    assignments: number;
    serviceReports: number;
    media: number;
    packs: number;
    portalCaptures: number;
    roofReportDrafts: number;
    docketRevisions: number;
    roofReportDocuments: number;
  };
}

export type RoofCycleBindingRecoveryDisposition =
  | "materialize_and_bind"
  | "bind_existing"
  | "already_bound"
  | "refused";

export interface RoofCycleBindingRecoveryPlanRow {
  job_number: string;
  job_id: string | null;
  disposition: RoofCycleBindingRecoveryDisposition;
  reason_code: string;
  reason: string;
  expected_cycle_number: number | null;
  candidate_attendance_cycle_id: string | null;
  current_attendance_cycle_id: string | null;
  intake_case_id: string | null;
  confidence: "high" | "low";
  exact_facts: {
    job_status: string | null;
    job_family: string | null;
    report_type: string | null;
    detail_builder_reference: string | null;
    canonical_builder_reference: string | null;
    immutable_attendance_cycle_ids: string[];
    operational_evidence_counts:
      RoofCycleBindingRecoverySnapshot["evidenceCounts"];
  };
  human_decision: {
    required: boolean;
    action: "apply_exact_cycle_binding" | "resolve_refusal" | "no_action";
    prompt: string;
  };
  snapshot_fingerprint: string;
}

export const ROOF_CYCLE_BINDING_REVIEW_CONTRACT =
  "roof-cycle-binding-recovery-review.v1";

export interface RoofCycleBindingRecoveryDependencies {
  loadSnapshot(jobNumber: string): Promise<RoofCycleBindingRecoverySnapshot>;
  bindInitialCycle(input: {
    jobId: string;
    cycleNumber: number;
    openReason: string;
    expectedCaseId: string;
    expectedCycleCount: 0 | 1;
    expectedExistingCycleId: string | null;
    requireZeroOperationalEvidence: boolean;
  }): Promise<{
    attendanceCycleId: string;
    cycleNumber: number;
    cycleCreated: boolean;
    cycleBound: boolean;
  }>;
}

function exactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MakesafeAttendanceCycleBindingRecoveryError(
      `${label} must be a JSON object`,
      400,
    );
  }
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new MakesafeAttendanceCycleBindingRecoveryError(
      `${label} must contain exactly: ${wanted.join(", ")}`,
      400,
    );
  }
}

function normalizedReference(value: string | null | undefined): string {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function snapshotFingerprint(
  snapshot: RoofCycleBindingRecoverySnapshot,
): string {
  return JSON.stringify({
    job: snapshot.job,
    detail: snapshot.detail,
    cycles: [...snapshot.cycles].sort((left, right) =>
      left.cycleNumber - right.cycleNumber || left.id.localeCompare(right.id)
    ),
    intakeCases: [...snapshot.intakeCases].sort((left, right) =>
      left.id.localeCompare(right.id)
    ),
    evidenceCounts: snapshot.evidenceCounts,
  });
}

function exactFacts(
  snapshot: RoofCycleBindingRecoverySnapshot,
): RoofCycleBindingRecoveryPlanRow["exact_facts"] {
  const directCases = snapshot.job
    ? snapshot.intakeCases.filter((intakeCase) =>
      intakeCase.state === "confirmed_live_job" &&
      intakeCase.jobId === snapshot.job!.id && !intakeCase.targetJobId
    )
    : [];
  const canonicalBuilderReference = directCases.length === 1
    ? directCases[0].builderWorkOrder ||
      directCases[0].builderPurchaseOrder || directCases[0].externalRef || null
    : null;
  return {
    job_status: snapshot.job?.status || null,
    job_family: snapshot.job?.family || null,
    report_type: snapshot.detail?.reportType || null,
    detail_builder_reference: snapshot.detail?.externalRef || null,
    canonical_builder_reference: canonicalBuilderReference,
    immutable_attendance_cycle_ids: snapshot.cycles.map((cycle) => cycle.id)
      .sort(),
    operational_evidence_counts: { ...snapshot.evidenceCounts },
  };
}

function refused(
  jobNumber: string,
  snapshot: RoofCycleBindingRecoverySnapshot,
  reasonCode: string,
  reason: string,
): RoofCycleBindingRecoveryPlanRow {
  return {
    job_number: jobNumber,
    job_id: snapshot.job?.id || null,
    disposition: "refused",
    reason_code: reasonCode,
    reason,
    expected_cycle_number: snapshot.detail?.cycleNumber ?? null,
    candidate_attendance_cycle_id: null,
    current_attendance_cycle_id: snapshot.detail?.attendanceCycleId || null,
    intake_case_id: null,
    confidence: "low",
    exact_facts: exactFacts(snapshot),
    human_decision: {
      required: true,
      action: "resolve_refusal",
      prompt:
        "Resolve the named refusal from canonical data before retrying this exact card.",
    },
    snapshot_fingerprint: snapshotFingerprint(snapshot),
  };
}

function planSnapshot(
  jobNumber: string,
  snapshot: RoofCycleBindingRecoverySnapshot,
): RoofCycleBindingRecoveryPlanRow {
  const job = snapshot.job;
  const detail = snapshot.detail;
  if (!job) {
    return refused(
      jobNumber,
      snapshot,
      "job_missing",
      "The exact authorized job number no longer resolves.",
    );
  }
  if (
    job.jobNumber !== jobNumber || job.type !== "makesafe" ||
    job.family !== "roof_report"
  ) {
    return refused(
      jobNumber,
      snapshot,
      "job_identity_drifted",
      "The job is no longer the authorized make-safe roof-report shape.",
    );
  }
  if (isMakesafeTerminalJobState(job.status)) {
    return refused(
      jobNumber,
      snapshot,
      "job_terminal",
      "A terminal job cannot receive a newly materialized attendance identity.",
    );
  }
  if (!detail || detail.jobId !== job.id) {
    return refused(
      jobNumber,
      snapshot,
      "detail_missing",
      "The make-safe detail row needed to prove the current cycle is absent.",
    );
  }
  if (detail.reportType !== "roof_report" || detail.cycleNumber !== 1) {
    return refused(
      jobNumber,
      snapshot,
      "detail_cycle_drifted",
      "Recovery is limited to an initial roof-report attendance cycle numbered 1.",
    );
  }

  const directCases = snapshot.intakeCases.filter((intakeCase) =>
    intakeCase.state === "confirmed_live_job" &&
    intakeCase.jobId === job.id &&
    !intakeCase.targetJobId &&
    Boolean(intakeCase.instructionKey)
  );
  if (directCases.length !== 1) {
    return refused(
      jobNumber,
      snapshot,
      directCases.length === 0
        ? "canonical_intake_case_missing"
        : "canonical_intake_case_ambiguous",
      "Exactly one direct confirmed deterministic intake case must own the job.",
    );
  }
  const intakeCase = directCases[0];
  const detailReference = normalizedReference(detail.externalRef);
  const caseReferences = [
    intakeCase.builderWorkOrder,
    intakeCase.builderPurchaseOrder,
    intakeCase.externalRef,
  ].map(normalizedReference).filter(Boolean);
  if (!detailReference || !caseReferences.includes(detailReference)) {
    return refused(
      jobNumber,
      snapshot,
      "builder_identity_drifted",
      "The current detail reference is not proved by the canonical intake case.",
    );
  }

  const cycles = snapshot.cycles.filter((cycle) => cycle.jobId === job.id);
  if (cycles.length > 1) {
    return refused(
      jobNumber,
      snapshot,
      "multiple_cycle_candidates",
      "More than one immutable attendance cycle exists; recovery refuses ambiguity.",
    );
  }

  if (detail.attendanceCycleId) {
    const exactCurrent = cycles.length === 1 &&
      cycles[0].id === detail.attendanceCycleId &&
      cycles[0].cycleNumber === detail.cycleNumber &&
      detail.cycleAttribution === "bound";
    if (!exactCurrent) {
      return refused(
        jobNumber,
        snapshot,
        "nonnull_current_cycle_drifted",
        "A non-null current cycle is not exactly bound inside the immutable cycle set.",
      );
    }
    return {
      job_number: jobNumber,
      job_id: job.id,
      disposition: "already_bound",
      reason_code: "already_bound",
      reason: "The exact current cycle is already bound; no write is required.",
      expected_cycle_number: detail.cycleNumber,
      candidate_attendance_cycle_id: cycles[0].id,
      current_attendance_cycle_id: detail.attendanceCycleId,
      intake_case_id: intakeCase.id,
      confidence: "high",
      exact_facts: exactFacts(snapshot),
      human_decision: {
        required: false,
        action: "no_action",
        prompt: "No attendance-cycle recovery decision is required.",
      },
      snapshot_fingerprint: snapshotFingerprint(snapshot),
    };
  }
  if (detail.cycleAttribution !== null) {
    return refused(
      jobNumber,
      snapshot,
      "null_cycle_attribution_drifted",
      "A null current cycle with non-null attribution cannot be repaired safely.",
    );
  }

  if (cycles.length === 1) {
    if (cycles[0].cycleNumber !== detail.cycleNumber) {
      return refused(
        jobNumber,
        snapshot,
        "cycle_candidate_number_mismatch",
        "The sole immutable cycle does not match the authoritative detail counter.",
      );
    }
    return {
      job_number: jobNumber,
      job_id: job.id,
      disposition: "bind_existing",
      reason_code: "exact_existing_cycle_candidate",
      reason:
        "One existing immutable cycle exactly matches the current counter.",
      expected_cycle_number: detail.cycleNumber,
      candidate_attendance_cycle_id: cycles[0].id,
      current_attendance_cycle_id: null,
      intake_case_id: intakeCase.id,
      confidence: "high",
      exact_facts: exactFacts(snapshot),
      human_decision: {
        required: true,
        action: "apply_exact_cycle_binding",
        prompt:
          "Approve binding the sole immutable cycle to this exact unassigned card.",
      },
      snapshot_fingerprint: snapshotFingerprint(snapshot),
    };
  }

  const evidenceTotal = Object.values(snapshot.evidenceCounts).reduce(
    (sum, count) => sum + count,
    0,
  );
  if (evidenceTotal !== 0) {
    return refused(
      jobNumber,
      snapshot,
      "missing_cycle_with_operational_evidence",
      "No immutable cycle exists and operational evidence is present; recovery will not invent attribution.",
    );
  }
  return {
    job_number: jobNumber,
    job_id: job.id,
    disposition: "materialize_and_bind",
    reason_code: "post_migration_initial_cycle_omission",
    reason:
      "Materialize cycle 1 from the persisted counter and canonical mint authority, then bind it without attributing evidence.",
    expected_cycle_number: detail.cycleNumber,
    candidate_attendance_cycle_id: null,
    current_attendance_cycle_id: null,
    intake_case_id: intakeCase.id,
    confidence: "high",
    exact_facts: exactFacts(snapshot),
    human_decision: {
      required: true,
      action: "apply_exact_cycle_binding",
      prompt:
        "Approve materializing and binding cycle 1 for this exact zero-evidence card.",
    },
    snapshot_fingerprint: snapshotFingerprint(snapshot),
  };
}

function groupPlansForReview(rows: RoofCycleBindingRecoveryPlanRow[]) {
  return {
    contract: ROOF_CYCLE_BINDING_REVIEW_CONTRACT,
    groups: (["high", "low"] as const).flatMap((confidence) => {
      const items = rows.filter((row) => row.confidence === confidence);
      if (!items.length) return [];
      const reasons = [...new Set(items.map((item) => item.reason_code))]
        .sort()
        .map((reasonCode) => ({
          reason_code: reasonCode,
          count: items.filter((item) => item.reason_code === reasonCode).length,
          items: items.filter((item) => item.reason_code === reasonCode),
        }));
      return [{ confidence, count: items.length, reasons }];
    }),
  };
}

async function planToken(
  jobNumbers: readonly string[],
  rows: readonly RoofCycleBindingRecoveryPlanRow[],
): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({
    contract: ROOF_CYCLE_BINDING_REVIEW_CONTRACT,
    job_numbers: jobNumbers,
    plans: rows.map((row) => ({
      job_number: row.job_number,
      disposition: row.disposition,
      reason_code: row.reason_code,
      snapshot_fingerprint: row.snapshot_fingerprint,
    })),
  }));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${
    [...digest].map((value) => value.toString(16).padStart(2, "0")).join("")
  }`;
}

function failureBody(
  message: string,
  rows: RoofCycleBindingRecoveryPlanRow[],
  extra: Record<string, unknown> = {},
) {
  return {
    ok: false,
    dry_run: false,
    error: message,
    counts: counts(rows),
    plans: rows,
    review_queue: groupPlansForReview(rows),
    writes_applied: 0,
    ...extra,
  };
}

function normalizeInput(input: RoofCycleBindingRecoveryInput): {
  jobNumbers: string[];
  dryRun: boolean;
  planToken: string | null;
} {
  exactKeys(
    input,
    ["dry_run", "job_numbers", "plan_token"],
    "cycle recovery body",
  );
  if (
    !Array.isArray(input.job_numbers) || input.job_numbers.length === 0 ||
    input.job_numbers.length > ROOF_CYCLE_BINDING_RECOVERY_JOB_NUMBERS.length
  ) {
    throw new MakesafeAttendanceCycleBindingRecoveryError(
      "job_numbers must be a non-empty exact list within the authorized five-card scope",
      400,
    );
  }
  const jobNumbers = input.job_numbers.map((value) => {
    if (typeof value !== "string" || !value || value !== value.trim()) {
      throw new MakesafeAttendanceCycleBindingRecoveryError(
        "job_numbers must contain non-empty exact strings",
        400,
      );
    }
    if (!AUTHORIZED_JOB_NUMBERS.has(value)) {
      throw new MakesafeAttendanceCycleBindingRecoveryError(
        `job ${value} is outside the authorized roof cycle recovery scope`,
        403,
      );
    }
    return value;
  });
  if (new Set(jobNumbers).size !== jobNumbers.length) {
    throw new MakesafeAttendanceCycleBindingRecoveryError(
      "job_numbers must not contain duplicates",
      400,
    );
  }
  if (typeof input.dry_run !== "boolean") {
    throw new MakesafeAttendanceCycleBindingRecoveryError(
      "dry_run must be an explicit boolean",
      400,
    );
  }
  if (input.dry_run) {
    if (input.plan_token !== null) {
      throw new MakesafeAttendanceCycleBindingRecoveryError(
        "dry-run plan_token must be null",
        400,
      );
    }
  } else {
    if (jobNumbers.length !== 1) {
      throw new MakesafeAttendanceCycleBindingRecoveryError(
        "cycle recovery apply accepts exactly one previously previewed job",
        400,
      );
    }
    if (
      typeof input.plan_token !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(input.plan_token)
    ) {
      throw new MakesafeAttendanceCycleBindingRecoveryError(
        "cycle recovery apply requires the exact dry-run plan_token",
        400,
      );
    }
  }
  return {
    jobNumbers,
    dryRun: input.dry_run,
    planToken: input.plan_token || null,
  };
}

function counts(rows: RoofCycleBindingRecoveryPlanRow[]) {
  return {
    selected: rows.length,
    materialize_and_bind:
      rows.filter((row) => row.disposition === "materialize_and_bind").length,
    bind_existing: rows.filter((row) => row.disposition === "bind_existing")
      .length,
    already_bound: rows.filter((row) => row.disposition === "already_bound")
      .length,
    refused: rows.filter((row) => row.disposition === "refused").length,
  };
}

export async function runRoofCycleBindingRecovery(
  input: RoofCycleBindingRecoveryInput,
  deps: RoofCycleBindingRecoveryDependencies,
): Promise<Record<string, unknown>> {
  const normalized = normalizeInput(input);
  const initialSnapshots = await Promise.all(
    normalized.jobNumbers.map((jobNumber) => deps.loadSnapshot(jobNumber)),
  );
  const initialPlans = normalized.jobNumbers.map((jobNumber, index) =>
    planSnapshot(jobNumber, initialSnapshots[index])
  );
  const initialCounts = counts(initialPlans);
  const initialPlanToken = await planToken(normalized.jobNumbers, initialPlans);
  if (normalized.dryRun) {
    return {
      ok: initialCounts.refused === 0,
      dry_run: true,
      counts: initialCounts,
      plans: initialPlans,
      review_queue: groupPlansForReview(initialPlans),
      plan_token: initialPlanToken,
      writes_applied: 0,
    };
  }
  if (normalized.planToken !== initialPlanToken) {
    const message =
      "cycle recovery apply refused: the dry-run plan token is stale or belongs to another selection";
    throw new MakesafeAttendanceCycleBindingRecoveryError(
      message,
      409,
      failureBody(message, initialPlans, { plan_token_valid: false }),
    );
  }
  if (initialCounts.refused > 0) {
    const message =
      "cycle recovery apply refused: at least one exact job is ineligible";
    throw new MakesafeAttendanceCycleBindingRecoveryError(
      message,
      409,
      failureBody(message, initialPlans, { plan_token_valid: true }),
    );
  }

  const preflightSnapshots = await Promise.all(
    normalized.jobNumbers.map((jobNumber) => deps.loadSnapshot(jobNumber)),
  );
  const preflightPlans = normalized.jobNumbers.map((jobNumber, index) =>
    planSnapshot(jobNumber, preflightSnapshots[index])
  );
  const drifted = preflightPlans.find((row, index) =>
    row.snapshot_fingerprint !== initialPlans[index].snapshot_fingerprint ||
    row.disposition !== initialPlans[index].disposition
  );
  if (drifted) {
    const message =
      `cycle recovery apply refused: ${drifted.job_number} drifted after planning`;
    throw new MakesafeAttendanceCycleBindingRecoveryError(
      message,
      409,
      failureBody(message, preflightPlans, {
        plan_token_valid: false,
        drifted_job_number: drifted.job_number,
      }),
    );
  }

  let writesApplied = 0;
  for (const plan of preflightPlans) {
    if (plan.disposition === "already_bound") continue;
    const jobId = plan.job_id!;
    const cycleNumber = plan.expected_cycle_number!;
    let bound;
    try {
      bound = await deps.bindInitialCycle({
        jobId,
        cycleNumber,
        openReason: "roof_report_intake_cycle_recovery",
        expectedCaseId: plan.intake_case_id!,
        expectedCycleCount: plan.disposition === "materialize_and_bind" ? 0 : 1,
        expectedExistingCycleId: plan.candidate_attendance_cycle_id,
        requireZeroOperationalEvidence:
          plan.disposition === "materialize_and_bind",
      });
    } catch (error) {
      const failedSnapshot = await deps.loadSnapshot(plan.job_number);
      const failedPlan = planSnapshot(plan.job_number, failedSnapshot);
      const message =
        `cycle recovery atomic apply refused for ${plan.job_number}: ${
          error instanceof Error ? error.message : String(error)
        }`;
      throw new MakesafeAttendanceCycleBindingRecoveryError(
        message,
        409,
        failureBody(message, [failedPlan], { plan_token_valid: false }),
      );
    }
    if (
      bound.cycleNumber !== cycleNumber || !bound.attendanceCycleId ||
      !bound.cycleBound ||
      (plan.candidate_attendance_cycle_id !== null &&
        bound.attendanceCycleId !== plan.candidate_attendance_cycle_id)
    ) {
      const failedSnapshot = await deps.loadSnapshot(plan.job_number);
      const failedPlan = planSnapshot(plan.job_number, failedSnapshot);
      const appliedWrites = Number(bound.cycleCreated) +
        Number(bound.cycleBound);
      const message =
        `cycle recovery atomic bind returned a mismatched identity for ${plan.job_number}`;
      throw new MakesafeAttendanceCycleBindingRecoveryError(
        message,
        503,
        failureBody(message, [failedPlan], {
          plan_token_valid: false,
          writes_applied: appliedWrites,
        }),
      );
    }
    writesApplied += Number(bound.cycleCreated) + Number(bound.cycleBound);
  }

  const finalSnapshots = await Promise.all(
    normalized.jobNumbers.map((jobNumber) => deps.loadSnapshot(jobNumber)),
  );
  const finalPlans = normalized.jobNumbers.map((jobNumber, index) =>
    planSnapshot(jobNumber, finalSnapshots[index])
  );
  const incomplete = finalPlans.find((row) =>
    row.disposition !== "already_bound"
  );
  if (incomplete) {
    const message =
      `cycle recovery postcondition failed for ${incomplete.job_number}: ${incomplete.reason_code}`;
    throw new MakesafeAttendanceCycleBindingRecoveryError(
      message,
      503,
      failureBody(message, finalPlans, {
        plan_token_valid: false,
        writes_applied: writesApplied,
      }),
    );
  }
  return {
    ok: true,
    dry_run: false,
    counts: counts(finalPlans),
    plans: finalPlans,
    applied_plans: preflightPlans,
    review_queue: groupPlansForReview(finalPlans),
    plan_token: initialPlanToken,
    writes_applied: writesApplied,
  };
}
