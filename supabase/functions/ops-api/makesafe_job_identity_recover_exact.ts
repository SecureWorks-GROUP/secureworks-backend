// deno-lint-ignore-file no-explicit-any
import { canonicalJsonAndHash } from "../_shared/release_packet/canonicalize.ts";
import {
  builderInstructionKey,
  builderInstructionScope,
  type BuilderWorkOrderIdentity,
} from "./makesafe_builder_work_order_identity.ts";

export const MAKESAFE_JOB_IDENTITY_RECOVERY_CONTRACT =
  "makesafe-job-identity-recover-exact.v1";

const LIVE_CASE_STATES = new Set(["confirmed_live_job", "blocked_live_job"]);
const JOB_NUMBER_RE = /^SWMS-\d{3,}$/;
const PURCHASE_ORDER_RE = /^PO-\d{3,}$/;
const INSTRUCTION_KEY_RE =
  /^fingerprint:[^\s/]+\/deliverable:[^\s/]+\/cycle:[1-9]\d*$/;
const RUN_KEY_RE = /^[a-z0-9][a-z0-9._:-]{0,79}$/;

export class MakesafeJobIdentityRecoveryError extends Error {
  readonly status: number;
  readonly body?: unknown;

  constructor(message: string, status = 409, body?: unknown) {
    super(message);
    this.name = "MakesafeJobIdentityRecoveryError";
    this.status = status;
    this.body = body;
  }
}

export interface MakesafeJobIdentityRecoverExactInput {
  job_number: string;
  dry_run?: boolean;
  expected_plan_hash?: string | null;
  run_key?: string | null;
}

export interface MakesafeJobIdentityRecoverySnapshot {
  job: {
    id: string;
    jobNumber: string;
    type: string;
    metadata: Record<string, unknown>;
    metadataValid?: boolean;
  } | null;
  detail: {
    externalRef: string | null;
    requestingCompanySlug: string | null;
  } | null;
  intakeCases: Array<{
    id: string;
    state: string;
    jobId: string | null;
    targetJobId: string | null;
    instructionKey: string | null;
    externalRefCanonical: string | null;
    builderWorkOrderCanonical: string | null;
    builderPurchaseOrderCanonical: string | null;
    workOrderPurchaseOrderIdentityKey: string | null;
  }>;
}

export interface MakesafeJobIdentityRecoveryDependencies {
  loadSnapshot(
    jobNumber: string,
  ): Promise<MakesafeJobIdentityRecoverySnapshot>;
  applyCorrection(input: {
    jobId: string;
    expectedExternalRef: string | null;
    expectedMetadata: Record<string, unknown>;
    externalRef: string;
    metadata: Record<string, unknown>;
    priorInstructionKeys: string[];
    correctedInstructionKey: string;
    reason: string;
  }): Promise<void>;
}

type RecoveryDisposition = "recover" | "already_current" | "refused";

export interface MakesafeJobIdentityRecoveryPlan {
  contract: typeof MAKESAFE_JOB_IDENTITY_RECOVERY_CONTRACT;
  job_number: string;
  disposition: RecoveryDisposition;
  reason_code: string;
  source_authority: {
    case_state: string | null;
    instruction_key_present: boolean;
    builder_work_order_number: string | null;
    builder_po_number: string | null;
    builder_instruction_key: string | null;
  };
  current_typed_identity: {
    builder_work_order_number: string | null;
    builder_po_number: string | null;
    builder_instruction_keys: string[];
    detail_external_ref: string | null;
    has_unpublishable_reference_value: boolean;
  };
}

interface InternalRecoveryPlan {
  publicPlan: MakesafeJobIdentityRecoveryPlan;
  planHash: string;
  jobId: string | null;
  correctedMetadata: Record<string, unknown> | null;
  targetExternalRef: string | null;
  targetInstructionKey: string | null;
  priorInstructionKeys: string[];
  expectedExternalRef: string | null;
  expectedMetadata: Record<string, unknown> | null;
}

function exactInputKeys(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MakesafeJobIdentityRecoveryError(
      "identity recovery body must be a JSON object",
      400,
    );
  }
  const allowed = new Set([
    "job_number",
    "dry_run",
    "expected_plan_hash",
    "run_key",
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new MakesafeJobIdentityRecoveryError(
      "identity recovery body contains unsupported fields",
      400,
    );
  }
}

function normalizeInput(input: MakesafeJobIdentityRecoverExactInput): {
  jobNumber: string;
  dryRun: boolean;
  expectedPlanHash: string | null;
  runKey: string | null;
} {
  exactInputKeys(input);
  const jobNumber = typeof input.job_number === "string"
    ? input.job_number.trim().toUpperCase()
    : "";
  if (!JOB_NUMBER_RE.test(jobNumber) || jobNumber !== input.job_number) {
    throw new MakesafeJobIdentityRecoveryError(
      "job_number must be one exact SecureWorks make-safe reference",
      400,
    );
  }
  const dryRun = input.dry_run === undefined ? true : input.dry_run;
  if (typeof dryRun !== "boolean") {
    throw new MakesafeJobIdentityRecoveryError(
      "dry_run must be a boolean when supplied",
      400,
    );
  }
  const expectedPlanHash = input.expected_plan_hash ?? null;
  const runKey = input.run_key ?? null;
  if (dryRun) {
    if (expectedPlanHash !== null || runKey !== null) {
      throw new MakesafeJobIdentityRecoveryError(
        "dry-run identity recovery does not accept an expected plan hash or run key",
        400,
      );
    }
  } else {
    if (
      typeof expectedPlanHash !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(expectedPlanHash)
    ) {
      throw new MakesafeJobIdentityRecoveryError(
        "live identity recovery requires the exact dry-run plan hash",
        400,
      );
    }
    if (typeof runKey !== "string" || !RUN_KEY_RE.test(runKey)) {
      throw new MakesafeJobIdentityRecoveryError(
        "live identity recovery requires a bounded auditable run_key",
        400,
      );
    }
  }
  return { jobNumber, dryRun, expectedPlanHash, runKey };
}

function clean(value: unknown): string | null {
  const text = String(value ?? "").trim().toUpperCase();
  return text || null;
}

function safeBuilderReference(value: unknown): string | null {
  const text = clean(value);
  if (!text || text.length > 80) return null;
  if (!/^[A-Z0-9-]+$/.test(text) || !/\d{3,}/.test(text)) return null;
  if (/^(?:UNKNOWN|NONE|NULL|TBC|TBD|NA|N-A|BOX|SENT)$/.test(text)) {
    return null;
  }
  return text;
}

function safePurchaseOrder(value: unknown): string | null {
  const text = clean(value);
  return text && PURCHASE_ORDER_RE.test(text) ? text : null;
}

function safePublishedBuilderReference(value: unknown): string | null {
  const reference = safeBuilderReference(value);
  return reference && builderInstructionScope({ workOrderNumber: reference })
    ? reference
    : null;
}

function publicCurrentIdentity(
  snapshot: MakesafeJobIdentityRecoverySnapshot,
  keys: string[],
): MakesafeJobIdentityRecoveryPlan["current_typed_identity"] {
  const metadata = snapshot.job?.metadata || {};
  const rawValues = [
    metadata.builder_claim_ref,
    metadata.builder_work_order_number,
    metadata.builder_po_number,
    snapshot.detail?.externalRef,
  ];
  const purchaseOrder = safePurchaseOrder(metadata.builder_po_number);
  return {
    builder_work_order_number: safePublishedBuilderReference(
      metadata.builder_claim_ref,
    ) || (!purchaseOrder
      ? safePublishedBuilderReference(metadata.builder_work_order_number)
      : null),
    builder_po_number: purchaseOrder,
    builder_instruction_keys: keys,
    detail_external_ref: safePublishedBuilderReference(
      snapshot.detail?.externalRef,
    ),
    has_unpublishable_reference_value: rawValues.some((value) =>
      clean(value) !== null &&
      safePublishedBuilderReference(value) === null &&
      safePurchaseOrder(value) === null
    ),
  };
}

function basePublicPlan(
  jobNumber: string,
  snapshot: MakesafeJobIdentityRecoverySnapshot,
  disposition: RecoveryDisposition,
  reasonCode: string,
  currentKeys: string[] = [],
): MakesafeJobIdentityRecoveryPlan {
  return {
    contract: MAKESAFE_JOB_IDENTITY_RECOVERY_CONTRACT,
    job_number: jobNumber,
    disposition,
    reason_code: reasonCode,
    source_authority: {
      case_state: null,
      instruction_key_present: false,
      builder_work_order_number: null,
      builder_po_number: null,
      builder_instruction_key: null,
    },
    current_typed_identity: publicCurrentIdentity(snapshot, currentKeys),
  };
}

function targetIdentity(
  workOrder: string,
  purchaseOrder: string,
): BuilderWorkOrderIdentity {
  return {
    builder_claim_ref: workOrder,
    builder_work_order_number: workOrder,
    builder_po_number: purchaseOrder,
    evidence_sources: ["canonical_intake_case"],
  };
}

function currentStructuredInstructionKeys(
  snapshot: MakesafeJobIdentityRecoverySnapshot,
): string[] {
  const metadata = snapshot.job?.metadata || {};
  const identity: BuilderWorkOrderIdentity = {
    builder_claim_ref: safeBuilderReference(metadata.builder_claim_ref),
    builder_work_order_number: safeBuilderReference(
      metadata.builder_work_order_number,
    ),
    builder_po_number: safePurchaseOrder(metadata.builder_po_number),
    evidence_sources: ["typed_job_metadata"],
  };
  const key = builderInstructionKey(identity, {
    requestingCompanySlug: snapshot.detail?.requestingCompanySlug,
    family: String(metadata.makesafe_job_family || "") || null,
  });
  return key ? [key] : [];
}

function hasConflictingWholeReference(
  value: unknown,
  workOrder: string,
  purchaseOrder: string,
): boolean {
  const reference = safeBuilderReference(value);
  if (!reference) return false;
  return reference !== workOrder &&
    reference !== `${workOrder}${purchaseOrder}`;
}

async function hashPlan(
  publicPlan: MakesafeJobIdentityRecoveryPlan,
  privateSnapshot: unknown,
): Promise<string> {
  const { hash } = await canonicalJsonAndHash({
    contract: MAKESAFE_JOB_IDENTITY_RECOVERY_CONTRACT,
    plan: publicPlan,
    snapshot: privateSnapshot,
  });
  return `sha256:${hash}`;
}

async function refusedPlan(
  jobNumber: string,
  snapshot: MakesafeJobIdentityRecoverySnapshot,
  reasonCode: string,
  currentKeys: string[] = [],
): Promise<InternalRecoveryPlan> {
  const publicPlan = basePublicPlan(
    jobNumber,
    snapshot,
    "refused",
    reasonCode,
    currentKeys,
  );
  return {
    publicPlan,
    planHash: await hashPlan(publicPlan, snapshot),
    jobId: snapshot.job?.id || null,
    correctedMetadata: null,
    targetExternalRef: null,
    targetInstructionKey: null,
    priorInstructionKeys: currentKeys,
    expectedExternalRef: null,
    expectedMetadata: null,
  };
}

async function planSnapshot(
  jobNumber: string,
  snapshot: MakesafeJobIdentityRecoverySnapshot,
): Promise<InternalRecoveryPlan> {
  const job = snapshot.job;
  if (!job) return await refusedPlan(jobNumber, snapshot, "job_not_found");
  if (job.jobNumber !== jobNumber || job.type !== "makesafe") {
    return await refusedPlan(jobNumber, snapshot, "job_identity_out_of_scope");
  }
  if (job.metadataValid === false) {
    return await refusedPlan(
      jobNumber,
      snapshot,
      "job_metadata_invalid",
    );
  }
  if (!snapshot.detail) {
    return await refusedPlan(jobNumber, snapshot, "makesafe_detail_missing");
  }

  // Only typed metadata participates in current PO-grain key comparison. The
  // legacy detail/external references are compared whole below; this recovery
  // never mines a PO from an untyped string, source document, or filename.
  const currentKeys = currentStructuredInstructionKeys(snapshot);
  const liveCases = snapshot.intakeCases.filter((intakeCase) =>
    LIVE_CASE_STATES.has(intakeCase.state) &&
    (intakeCase.jobId === job.id || intakeCase.targetJobId === job.id)
  );
  if (liveCases.length !== 1) {
    return await refusedPlan(
      jobNumber,
      snapshot,
      liveCases.length === 0
        ? "canonical_live_case_missing"
        : "canonical_live_case_ambiguous",
      currentKeys,
    );
  }
  const sourceCase = liveCases[0];
  if (
    sourceCase.jobId && sourceCase.targetJobId &&
    sourceCase.jobId !== sourceCase.targetJobId
  ) {
    return await refusedPlan(
      jobNumber,
      snapshot,
      "canonical_case_binding_conflict",
      currentKeys,
    );
  }

  const workOrder = safeBuilderReference(
    sourceCase.builderWorkOrderCanonical,
  );
  const purchaseOrder = safePurchaseOrder(
    sourceCase.builderPurchaseOrderCanonical,
  );
  const sourceInstructionKey = String(sourceCase.instructionKey || "").trim();
  if (!workOrder) {
    return await refusedPlan(
      jobNumber,
      snapshot,
      "canonical_builder_work_order_missing_or_junk",
      currentKeys,
    );
  }
  if (!builderInstructionScope({ workOrderNumber: workOrder })) {
    return await refusedPlan(
      jobNumber,
      snapshot,
      "canonical_builder_work_order_unknown_scope",
      currentKeys,
    );
  }
  if (!purchaseOrder) {
    return await refusedPlan(
      jobNumber,
      snapshot,
      "canonical_builder_po_missing_or_junk",
      currentKeys,
    );
  }
  if (!INSTRUCTION_KEY_RE.test(sourceInstructionKey)) {
    return await refusedPlan(
      jobNumber,
      snapshot,
      "canonical_instruction_key_missing_or_junk",
      currentKeys,
    );
  }
  const expectedWoPoKey = `wo:${workOrder}/po:${purchaseOrder}`;
  if (sourceCase.workOrderPurchaseOrderIdentityKey !== expectedWoPoKey) {
    return await refusedPlan(
      jobNumber,
      snapshot,
      "canonical_wo_po_identity_key_conflict",
      currentKeys,
    );
  }

  const correctedInstructionKey = builderInstructionKey(
    targetIdentity(workOrder, purchaseOrder),
    {
      requestingCompanySlug: snapshot.detail.requestingCompanySlug,
      family: String(job.metadata.makesafe_job_family || "") || null,
    },
  );
  if (!correctedInstructionKey) {
    return await refusedPlan(
      jobNumber,
      snapshot,
      "canonical_builder_instruction_key_unavailable",
      currentKeys,
    );
  }
  const currentTypedPurchaseOrder = safePurchaseOrder(
    job.metadata.builder_po_number,
  );
  if (
    (currentTypedPurchaseOrder &&
      currentTypedPurchaseOrder !== purchaseOrder) ||
    currentKeys.some((key) => key !== correctedInstructionKey)
  ) {
    const refused = await refusedPlan(
      jobNumber,
      snapshot,
      "good_builder_instruction_key_conflict",
      currentKeys,
    );
    refused.publicPlan.source_authority = {
      case_state: sourceCase.state,
      instruction_key_present: true,
      builder_work_order_number: workOrder,
      builder_po_number: purchaseOrder,
      builder_instruction_key: correctedInstructionKey,
    };
    refused.planHash = await hashPlan(refused.publicPlan, snapshot);
    return refused;
  }
  const currentGroupValues = [
    job.metadata.external_ref,
    job.metadata.builder_claim_ref,
    job.metadata.builder_work_order_number,
    snapshot.detail.externalRef,
  ];
  if (
    currentGroupValues.some((value) =>
      hasConflictingWholeReference(value, workOrder, purchaseOrder)
    )
  ) {
    const refused = await refusedPlan(
      jobNumber,
      snapshot,
      "current_builder_group_reference_conflict",
      currentKeys,
    );
    refused.publicPlan.source_authority = {
      case_state: sourceCase.state,
      instruction_key_present: true,
      builder_work_order_number: workOrder,
      builder_po_number: purchaseOrder,
      builder_instruction_key: correctedInstructionKey,
    };
    refused.planHash = await hashPlan(refused.publicPlan, snapshot);
    return refused;
  }

  const correctedMetadata: Record<string, unknown> = {
    ...job.metadata,
    external_ref: workOrder,
    builder_claim_ref: workOrder,
    builder_work_order_number: workOrder,
    builder_po_number: purchaseOrder,
  };
  const storedWorkOrder = clean(job.metadata.builder_work_order_number);
  const alreadyCurrent = clean(job.metadata.external_ref) === workOrder &&
    clean(job.metadata.builder_claim_ref) === workOrder &&
    (storedWorkOrder === workOrder ||
      storedWorkOrder === `${workOrder}${purchaseOrder}`) &&
    clean(job.metadata.builder_po_number) === purchaseOrder &&
    clean(snapshot.detail.externalRef) === workOrder;
  const publicPlan = basePublicPlan(
    jobNumber,
    snapshot,
    alreadyCurrent ? "already_current" : "recover",
    alreadyCurrent
      ? "typed_identity_already_current"
      : "historical_typed_identity_missing",
    currentKeys,
  );
  publicPlan.source_authority = {
    case_state: sourceCase.state,
    instruction_key_present: true,
    builder_work_order_number: workOrder,
    builder_po_number: purchaseOrder,
    builder_instruction_key: correctedInstructionKey,
  };
  return {
    publicPlan,
    planHash: await hashPlan(publicPlan, {
      job_id: job.id,
      case_id: sourceCase.id,
      source_instruction_key: sourceInstructionKey,
      metadata: job.metadata,
      detail_external_ref: snapshot.detail.externalRef,
    }),
    jobId: job.id,
    correctedMetadata,
    targetExternalRef: workOrder,
    targetInstructionKey: correctedInstructionKey,
    priorInstructionKeys: currentKeys,
    expectedExternalRef: snapshot.detail.externalRef,
    expectedMetadata: job.metadata,
  };
}

function publicResult(
  plan: InternalRecoveryPlan,
  dryRun: boolean,
  writesApplied: number,
  extra: Record<string, unknown> = {},
) {
  return {
    ok: plan.publicPlan.disposition !== "refused",
    dry_run: dryRun,
    plan: plan.publicPlan,
    plan_hash: plan.planHash,
    writes_applied: writesApplied,
    ...extra,
  };
}

export async function runMakesafeJobIdentityRecoverExact(
  input: MakesafeJobIdentityRecoverExactInput,
  deps: MakesafeJobIdentityRecoveryDependencies,
): Promise<Record<string, unknown>> {
  const normalized = normalizeInput(input);
  const snapshot = await deps.loadSnapshot(normalized.jobNumber);
  const plan = await planSnapshot(normalized.jobNumber, snapshot);
  if (normalized.dryRun) return publicResult(plan, true, 0);

  if (normalized.expectedPlanHash !== plan.planHash) {
    const message =
      "identity recovery refused: the dry-run plan hash is stale or belongs to another card";
    throw new MakesafeJobIdentityRecoveryError(
      message,
      409,
      publicResult(plan, false, 0, {
        error: message,
        plan_hash_valid: false,
      }),
    );
  }
  if (plan.publicPlan.disposition === "refused") {
    const message = `identity recovery refused: ${plan.publicPlan.reason_code}`;
    throw new MakesafeJobIdentityRecoveryError(
      message,
      409,
      publicResult(plan, false, 0, {
        error: message,
        plan_hash_valid: true,
      }),
    );
  }
  if (plan.publicPlan.disposition === "already_current") {
    return publicResult(plan, false, 0, {
      run_key: normalized.runKey,
      read_back_verified: true,
    });
  }

  try {
    await deps.applyCorrection({
      jobId: plan.jobId!,
      expectedExternalRef: plan.expectedExternalRef,
      expectedMetadata: plan.expectedMetadata!,
      externalRef: plan.targetExternalRef!,
      metadata: plan.correctedMetadata!,
      priorInstructionKeys: plan.priorInstructionKeys,
      correctedInstructionKey: plan.targetInstructionKey!,
      reason: `historical_source_identity_recovery:${normalized.runKey}`,
    });
  } catch {
    const message = "identity recovery atomic correction failed";
    throw new MakesafeJobIdentityRecoveryError(
      message,
      503,
      publicResult(plan, false, 0, {
        error: message,
        plan_hash_valid: true,
        run_key: normalized.runKey,
        read_back_verified: false,
      }),
    );
  }

  const readBackSnapshot = await deps.loadSnapshot(normalized.jobNumber);
  const readBackPlan = await planSnapshot(
    normalized.jobNumber,
    readBackSnapshot,
  );
  if (
    readBackPlan.publicPlan.disposition !== "already_current" ||
    readBackPlan.targetInstructionKey !== plan.targetInstructionKey ||
    readBackPlan.targetExternalRef !== plan.targetExternalRef
  ) {
    const message = "identity recovery postcondition read-back failed";
    throw new MakesafeJobIdentityRecoveryError(
      message,
      503,
      publicResult(readBackPlan, false, 1, {
        error: message,
        plan_hash_valid: false,
        run_key: normalized.runKey,
        read_back_verified: false,
      }),
    );
  }
  return publicResult(readBackPlan, false, 1, {
    applied_plan: plan.publicPlan,
    applied_plan_hash: plan.planHash,
    run_key: normalized.runKey,
    read_back_verified: true,
  });
}

async function loadSnapshotFromDatabase(
  client: any,
  orgId: string,
  jobNumber: string,
): Promise<MakesafeJobIdentityRecoverySnapshot> {
  const { data: jobs, error: jobError } = await client.from("jobs")
    .select("id,job_number,type,metadata")
    .eq("org_id", orgId)
    .eq("job_number", jobNumber)
    .limit(2);
  if (jobError) {
    throw new MakesafeJobIdentityRecoveryError(
      "identity recovery job read failed",
      503,
    );
  }
  if ((jobs || []).length !== 1) {
    return { job: null, detail: null, intakeCases: [] };
  }
  const job = jobs[0];
  const metadataValid = !!job.metadata &&
    typeof job.metadata === "object" && !Array.isArray(job.metadata);
  const caseColumns =
    "id,state,job_id,target_job_id,instruction_key,external_ref_canonical,builder_wo_canonical,builder_po_canonical,wo_po_identity_key";
  const [detailResult, directCasesResult, targetCasesResult] = await Promise
    .all([
      client.from("makesafe_job_details")
        .select("external_ref,requesting_company_slug")
        .eq("job_id", job.id)
        .maybeSingle(),
      client.from("makesafe_intake_cases")
        .select(caseColumns)
        .eq("org_id", orgId)
        .eq("job_id", job.id)
        .in("state", [...LIVE_CASE_STATES]),
      client.from("makesafe_intake_cases")
        .select(caseColumns)
        .eq("org_id", orgId)
        .eq("target_job_id", job.id)
        .in("state", [...LIVE_CASE_STATES]),
    ]);
  if (
    detailResult.error || directCasesResult.error || targetCasesResult.error
  ) {
    throw new MakesafeJobIdentityRecoveryError(
      "identity recovery canonical source read failed",
      503,
    );
  }
  const caseMap = new Map<string, any>();
  for (
    const intakeCase of [
      ...(directCasesResult.data || []),
      ...(targetCasesResult.data || []),
    ]
  ) {
    if (intakeCase?.id) caseMap.set(String(intakeCase.id), intakeCase);
  }
  const detail = detailResult.data;
  return {
    job: {
      id: String(job.id),
      jobNumber: String(job.job_number),
      type: String(job.type),
      metadata: metadataValid ? job.metadata : {},
      metadataValid,
    },
    detail: detail
      ? {
        externalRef: detail.external_ref || null,
        requestingCompanySlug: detail.requesting_company_slug || null,
      }
      : null,
    intakeCases: [...caseMap.values()].map((intakeCase) => ({
      id: String(intakeCase.id),
      state: String(intakeCase.state),
      jobId: intakeCase.job_id || null,
      targetJobId: intakeCase.target_job_id || null,
      instructionKey: intakeCase.instruction_key || null,
      externalRefCanonical: intakeCase.external_ref_canonical || null,
      builderWorkOrderCanonical: intakeCase.builder_wo_canonical || null,
      builderPurchaseOrderCanonical: intakeCase.builder_po_canonical || null,
      workOrderPurchaseOrderIdentityKey: intakeCase.wo_po_identity_key || null,
    })),
  };
}

/**
 * Database-bound entrypoint for `ops-api?action=makesafe_job_identity_recover_exact`.
 * The route remains responsible for API-key and POST-only authorization.
 */
export async function makesafeJobIdentityRecoverExactAction(
  client: any,
  orgId: string,
  input: MakesafeJobIdentityRecoverExactInput,
): Promise<Record<string, unknown>> {
  return await runMakesafeJobIdentityRecoverExact(input, {
    loadSnapshot: (jobNumber) =>
      loadSnapshotFromDatabase(client, orgId, jobNumber),
    applyCorrection: async (correction) => {
      const { error } = await client.rpc(
        "apply_makesafe_job_identity_recovery_exact",
        {
          p_job_id: correction.jobId,
          p_expected_external_ref: correction.expectedExternalRef,
          p_expected_metadata: correction.expectedMetadata,
          p_external_ref: correction.externalRef,
          p_metadata: correction.metadata,
          p_prior_instruction_keys: correction.priorInstructionKeys,
          p_corrected_instruction_key: correction.correctedInstructionKey,
          p_reason: correction.reason,
        },
      );
      if (error) {
        throw new MakesafeJobIdentityRecoveryError(
          "identity recovery atomic correction failed",
          503,
        );
      }
    },
  });
}
