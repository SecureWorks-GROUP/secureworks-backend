import {
  isSha256Revision,
  type Sha256Revision,
} from "./makesafe_readiness_revision.ts";

export const MAKESAFE_STATE_CONTRACT_VERSION = "makesafe-state.v2";
export const MAKESAFE_BOARD_V2_CONTRACT_VERSION = "makesafe-board.v2";
export const MAKESAFE_COMPLETION_PHOTO_FLOOR_V2 = 5;

export const CANONICAL_MAKESAFE_SUBSTATUSES = [
  "company_contact_required",
  "company_contact_done",
  "waiting_on_trade_report",
  "admin_to_send_report",
  "ready_to_invoice",
  "complete",
] as const;
export type CanonicalMakesafeSubstatus =
  (typeof CANONICAL_MAKESAFE_SUBSTATUSES)[number];

export const MAKESAFE_V2_OPS_STAGES = [
  "new",
  "allocated",
  "trade_report_in",
  "report_ready",
  "completed",
  "archive",
] as const;
export type MakesafeV2OpsStage = (typeof MAKESAFE_V2_OPS_STAGES)[number];
export type MakesafeV2TradeColumn =
  | "New"
  | "Allocated"
  | "Complete"
  | "Archive";

export const MAKESAFE_V2_OPS_LABELS: Record<MakesafeV2OpsStage, string> = {
  new: "New / Unallocated",
  allocated: "Allocated / Waiting on Trade",
  trade_report_in: "Trade Report In",
  report_ready: "Docs Ready",
  completed: "Completed",
  archive: "Archive",
};

export const MAKESAFE_V2_TRADE_COLUMNS: Record<
  MakesafeV2OpsStage,
  MakesafeV2TradeColumn
> = {
  new: "New",
  allocated: "Allocated",
  trade_report_in: "Complete",
  report_ready: "Complete",
  completed: "Archive",
  archive: "Archive",
};

export const BLOCKER_CODES = [
  "intake_exception",
  "missing_job_binding",
  "company_contact_required",
  "no_current_cycle_assignment",
  "backfill_cycle_scope",
  "missing_current_cycle_report",
  "missing_current_cycle_photos",
  "missing_portal_capture",
  "missing_family_rule",
  "missing_pricing_disposition",
  "missing_invoice_obligation_revision",
  "missing_pack_revision",
  "stale_readiness_revision",
  "stale_approval",
  "money_review_required",
  "cancellation_review_required",
  "terminal_proof_required",
  "projection_input_error",
] as const;
export type BlockerCode = (typeof BLOCKER_CODES)[number];

export const NEXT_ACTION_CODES = [
  "resolve_intake_exception",
  "review_cancellation",
  "resolve_blocker",
  "contact_company",
  "allocate_trade",
  "submit_trade_report",
  "bind_cycle_evidence",
  "prepare_docket",
  "review_docs",
  "approve_invoice",
  "approve_release",
  "execute_release",
  "verify_closeout",
  "none",
] as const;
export type NextActionCode = (typeof NEXT_ACTION_CODES)[number];
export type MakesafeOwnerRole =
  | "ops"
  | "trade"
  | "captain"
  | "system"
  | "none";

export interface StateDiagnostic {
  code:
    | "substatus_ahead_of_facts"
    | "facts_ahead_of_substatus"
    | "legacy_substatus"
    | "projection_input_error";
  severity: "warning" | "hard";
  reason: string;
  evidence_refs: string[];
}

export interface ReadinessDimension {
  state: "absent" | "invalid" | "ready" | "superseded";
  ready: boolean;
  readiness_revision: Sha256Revision | null;
  dependency_generation: number;
  attendance_cycle_set_hash: Sha256Revision | null;
  invalidated_at: string | null;
  invalidation_reason: string | null;
}

export interface BlockerFact {
  code: BlockerCode;
  source: "derived" | "operator";
  severity: "info" | "warning" | "hard";
  attendance_cycle_id: string | null;
  reason: string;
  held_since: string;
  owner_role: Exclude<MakesafeOwnerRole, "none">;
  recovery_action: NextActionCode;
  recovery_instruction: string;
  evidence_refs: string[];
}

export interface BlockerDimension {
  blocked: boolean;
  primary: BlockerFact | null;
  active: BlockerFact[];
}

export interface CancellationDimension {
  state: "none" | "requested" | "confirmed" | "rescinded";
  reason_code: string | null;
  note: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_id: string | null;
}

export interface TerminalProofDimension {
  state: "absent" | "valid" | "superseded";
  proof_id: string | null;
  kind:
    | "release_closeout"
    | "verified_historical_closeout"
    | "approved_nonwork_archive"
    | null;
  attendance_cycle_ids: string[];
  readiness_revision: string | null;
  release_revision_id: string | null;
  closeout_revision_id: string | null;
  proven_at: string | null;
  evidence_refs: string[];
}

export interface NextActionDimension {
  code: NextActionCode;
  owner_role: MakesafeOwnerRole;
  since: string;
  due_at: string | null;
  reason: string;
  action_ref: string | null;
}

export interface MakesafeStateV2 {
  contract_version: "makesafe-state.v2";
  computed_at: string;
  identity: {
    authority_kind:
      | "effective_intake_case"
      | "legacy_job_record"
      | "unresolved_authority"
      | null;
    authority_revision_id: string | null;
    source_instruction_id: string | null;
    lineage_id: string | null;
    case_id: string | null;
    job_id: string | null;
    job_number: string | null;
    property_id: string | null;
    attendance_cycle_ids: string[];
    current_attendance_cycle_id: string | null;
  };
  substatus: CanonicalMakesafeSubstatus | null;
  ops_stage: MakesafeV2OpsStage;
  ops_label: string;
  trade_column: MakesafeV2TradeColumn;
  stage_evidence: {
    determinate: boolean;
    reason: string;
    evidence_refs: string[];
  };
  readiness: ReadinessDimension;
  blocker: BlockerDimension;
  cancellation: CancellationDimension;
  terminal_proof: TerminalProofDimension;
  next_action: NextActionDimension;
  diagnostics: StateDiagnostic[];
}

export interface VersionedCycleFact {
  id: string;
  attendance_cycle_id: string | null;
  version: number | null;
  content_hash: string | null;
  status?: string | null;
  role?: string | null;
}

const MAKESAFE_DOCUMENT_ROLE_ALIASES: Record<string, string> = {
  roof_report: "roof_report",
  "roof-report": "roof_report",
  roof: "roof_report",
  assessment_report: "assessment_report",
  assessment: "assessment_report",
  assessment_report_quote: "assessment_report",
  photos: "photos",
  photo: "photos",
  photo_schedule: "photos",
  photo_report: "photos",
  quote: "quote",
  quotation: "quote",
  scope: "quote",
  scope_of_works: "quote",
  makesafe_report: "makesafe_report",
};

export function canonicalizeMakesafeDocumentRole(
  rawType: string | null | undefined,
): string | null {
  const raw = String(rawType || "").trim().toLowerCase().replace(/\s+/g, "_");
  return MAKESAFE_DOCUMENT_ROLE_ALIASES[raw] || null;
}

export interface MakesafeFamilyRule {
  code: string;
  kind: "physical" | "portal" | "report_only";
  matrix_revision: string;
  matrix_content_hash: string;
  completion_photo_floor?: number;
  required_document_types?: string[];
  required_portal_roles?: string[];
}

export interface MakesafeStateInput {
  computed_at: string;
  projection_input_errors: Array<{
    reason: string;
    evidence_refs: string[];
  }>;
  identity: MakesafeStateV2["identity"];
  current_attendance_cycle_set_hash: Sha256Revision | null;
  source_version: number | null;
  source_content_hash: string | null;
  lineage_version: number | null;
  lineage_correction_hash: string | null;
  lineage_supersession_hash: string | null;
  substatus_raw: string | null;
  job_created_at: string | null;
  company_contact_present: boolean;
  intake_exception: boolean;
  cycle_attribution_error: string | null;
  family_rule: MakesafeFamilyRule | null;
  attendance_cycles: VersionedCycleFact[];
  assignments: VersionedCycleFact[];
  service_reports: VersionedCycleFact[];
  documents: VersionedCycleFact[];
  completion_photos: VersionedCycleFact[];
  portal_captures: VersionedCycleFact[];
  readiness: ReadinessDimension;
  operator_blockers: BlockerFact[];
  cancellation: CancellationDimension;
  terminal_proof: TerminalProofDimension;
  workflow: {
    pricing_disposition_revision: string | null;
    invoice_obligation_id: string | null;
    invoice_obligation_revision: string | null;
    docket_revision_id: string | null;
    docket_artifact_hash: string | null;
    draft_assembled: boolean;
    docs_reviewed: boolean;
    invoice_approved: boolean;
    release_approved: boolean;
    released: boolean;
    money_review_required: boolean;
    stale_approval: boolean;
  };
}

export interface V1V2Diff {
  equal: boolean;
  fields: Array<{
    path: string;
    v1: unknown;
    v2: unknown;
  }>;
}

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
const REPORT_STATUSES = new Set(["submitted", "approved"]);

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  const aa = [...a].sort();
  const bb = [...b].sort();
  return aa.length === bb.length &&
    aa.every((value, index) => value === bb[index]);
}

function emptyCancellation(): CancellationDimension {
  return {
    state: "none",
    reason_code: null,
    note: null,
    decided_by: null,
    decided_at: null,
    decision_id: null,
  };
}

function emptyTerminalProof(): TerminalProofDimension {
  return {
    state: "absent",
    proof_id: null,
    kind: null,
    attendance_cycle_ids: [],
    readiness_revision: null,
    release_revision_id: null,
    closeout_revision_id: null,
    proven_at: null,
    evidence_refs: [],
  };
}

function stableCurrentFacts(
  rows: VersionedCycleFact[],
  currentCycleId: string | null,
  kind: string,
  diagnostics: StateDiagnostic[],
): VersionedCycleFact[] {
  if (!currentCycleId) return [];
  const current: VersionedCycleFact[] = [];
  for (const row of rows) {
    if (row.attendance_cycle_id !== currentCycleId) continue;
    const valid = !!row.id && Number.isSafeInteger(row.version) &&
      Number(row.version) >= 1 && isSha256Revision(row.content_hash);
    if (!valid) {
      diagnostics.push({
        code: "projection_input_error",
        severity: "hard",
        reason: `${kind} ${
          row.id || "(blank)"
        } lacks immutable version/hash identity`,
        evidence_refs: row.id ? [row.id] : [],
      });
      continue;
    }
    current.push(row);
  }
  return current;
}

function validateAttendanceCycles(
  rows: VersionedCycleFact[],
  expectedIds: string[],
  diagnostics: StateDiagnostic[],
) {
  const actualIds = rows.map((row) => row.id).sort();
  if (!sameStrings(actualIds, expectedIds)) {
    diagnostics.push({
      code: "projection_input_error",
      severity: "hard",
      reason:
        "Attendance-cycle rows do not exactly match the identity cycle set.",
      evidence_refs: actualIds,
    });
  }
  for (const row of rows) {
    if (
      !row.id || !Number.isSafeInteger(row.version) ||
      Number(row.version) < 1 ||
      !isSha256Revision(row.content_hash)
    ) {
      diagnostics.push({
        code: "projection_input_error",
        severity: "hard",
        reason: `attendance cycle ${
          row.id || "(blank)"
        } lacks immutable version/hash identity`,
        evidence_refs: row.id ? [row.id] : [],
      });
    }
  }
}

function readinessFromInput(
  readiness: ReadinessDimension,
  currentCycleSetHash: Sha256Revision | null,
  diagnostics: StateDiagnostic[],
): ReadinessDimension {
  const generationValid =
    Number.isSafeInteger(readiness.dependency_generation) &&
    readiness.dependency_generation >= 0;
  const revisionValid = readiness.readiness_revision === null ||
    isSha256Revision(readiness.readiness_revision);
  const cycleHashValid = readiness.attendance_cycle_set_hash === null ||
    isSha256Revision(readiness.attendance_cycle_set_hash);
  if (!generationValid || !revisionValid || !cycleHashValid) {
    diagnostics.push({
      code: "projection_input_error",
      severity: "hard",
      reason: "current readiness identity is malformed",
      evidence_refs: [],
    });
    return {
      ...readiness,
      state: "invalid",
      ready: false,
      readiness_revision: revisionValid ? readiness.readiness_revision : null,
      attendance_cycle_set_hash: cycleHashValid
        ? readiness.attendance_cycle_set_hash
        : null,
    };
  }
  if (
    readiness.attendance_cycle_set_hash && currentCycleSetHash &&
    readiness.attendance_cycle_set_hash !== currentCycleSetHash
  ) {
    return { ...readiness, state: "superseded", ready: false };
  }
  if (
    readiness.ready && readiness.state === "ready" &&
    isSha256Revision(readiness.readiness_revision) &&
    readiness.attendance_cycle_set_hash === currentCycleSetHash
  ) {
    return readiness;
  }
  return {
    ...readiness,
    state: readiness.readiness_revision
      ? (readiness.invalidated_at ? "superseded" : "invalid")
      : "absent",
    ready: false,
  };
}

function blocker(
  input: MakesafeStateInput,
  code: BlockerCode,
  reason: string,
  recoveryAction: NextActionCode,
  recoveryInstruction: string,
  owner: Exclude<MakesafeOwnerRole, "none"> = "ops",
  severity: BlockerFact["severity"] = "hard",
  evidenceRefs: string[] = [],
): BlockerFact {
  return {
    code,
    source: "derived",
    severity,
    attendance_cycle_id: input.identity.current_attendance_cycle_id,
    reason,
    held_since: input.job_created_at || input.computed_at,
    owner_role: owner,
    recovery_action: recoveryAction,
    recovery_instruction: recoveryInstruction,
    evidence_refs: evidenceRefs,
  };
}

function expectedStageForSubstatus(
  value: CanonicalMakesafeSubstatus,
): MakesafeV2OpsStage {
  if (
    value === "company_contact_done" || value === "waiting_on_trade_report"
  ) return "allocated";
  if (value === "admin_to_send_report") return "trade_report_in";
  if (value === "ready_to_invoice") return "report_ready";
  if (value === "complete") return "completed";
  return "new";
}

function stageRank(stage: MakesafeV2OpsStage): number {
  return MAKESAFE_V2_OPS_STAGES.indexOf(stage);
}

function selectNextAction(
  input: MakesafeStateInput,
  stage: MakesafeV2OpsStage,
  blockers: BlockerFact[],
  hasAssignment: boolean,
  handoffSatisfied: boolean,
  terminalValid: boolean,
): NextActionDimension {
  let code: NextActionCode;
  let owner: MakesafeOwnerRole;
  let reason: string;
  let actionRef: string | null = input.identity.job_id;
  if (input.intake_exception) {
    code = "resolve_intake_exception";
    owner = "ops";
    reason = "The intake case must be resolved before operational work.";
    actionRef = input.identity.case_id;
  } else if (input.cancellation.state === "requested") {
    code = "review_cancellation";
    owner = "captain";
    reason = "A cancellation request requires an explicit decision.";
    actionRef = input.cancellation.decision_id;
  } else if (input.cancellation.state === "confirmed") {
    code = "none";
    owner = "none";
    reason =
      "Cancellation is confirmed; unsafe operational actions are suppressed.";
  } else if (terminalValid) {
    code = "none";
    owner = "none";
    reason = `The current fact-derived stage is ${stage}.`;
  } else {
    const hard = blockers.find((item) =>
      item.severity === "hard" &&
      ![
        "company_contact_required",
        "no_current_cycle_assignment",
        "missing_current_cycle_report",
        "missing_current_cycle_photos",
        "missing_portal_capture",
        "missing_pack_revision",
        "terminal_proof_required",
      ].includes(item.code)
    );
    if (hard) {
      code = hard.recovery_action;
      owner = hard.owner_role;
      reason = hard.reason;
    } else if (!input.company_contact_present) {
      code = "contact_company";
      owner = "ops";
      reason = "Company contact is not recorded.";
    } else if (!hasAssignment) {
      code = "allocate_trade";
      owner = "ops";
      reason = "No active assignment is bound to the current attendance cycle.";
    } else if (!handoffSatisfied) {
      code = input.cycle_attribution_error
        ? "bind_cycle_evidence"
        : "submit_trade_report";
      owner = input.cycle_attribution_error ? "ops" : "trade";
      reason = input.cycle_attribution_error ||
        "The exact current-cycle completion handoff is incomplete.";
    } else if (!input.workflow.docket_revision_id) {
      code = "prepare_docket";
      owner = "ops";
      reason = "Completion handoff is satisfied but no current docket exists.";
    } else if (!input.workflow.docs_reviewed) {
      code = "review_docs";
      owner = "ops";
      reason = "The current docket requires document review.";
    } else if (!input.workflow.invoice_approved) {
      code = "approve_invoice";
      owner = "captain";
      reason = "The current invoice obligation requires approval.";
    } else if (!input.workflow.release_approved) {
      code = "approve_release";
      owner = "captain";
      reason = "The current release requires approval.";
    } else if (!input.workflow.released) {
      code = "execute_release";
      owner = "ops";
      reason = "The approved current release has not been executed.";
    } else if (!terminalValid) {
      code = "verify_closeout";
      owner = "ops";
      reason = "Released work lacks exact-cycle terminal proof.";
    } else {
      code = "none";
      owner = "none";
      reason = `The current fact-derived stage is ${stage}.`;
    }
  }
  return {
    code,
    owner_role: owner,
    since: input.job_created_at || input.computed_at,
    due_at: null,
    reason,
    action_ref: actionRef,
  };
}

export function projectMakesafeStateV2(
  input: MakesafeStateInput,
): MakesafeStateV2 {
  const diagnostics: StateDiagnostic[] = input.projection_input_errors.map(
    (item) => ({
      code: "projection_input_error",
      severity: "hard",
      reason: item.reason,
      evidence_refs: item.evidence_refs,
    }),
  );
  const currentCycleId = input.identity.current_attendance_cycle_id;
  const sortedCycleIds = [...new Set(input.identity.attendance_cycle_ids)]
    .sort();
  const currentCycleSetHash = input.current_attendance_cycle_set_hash;
  if (
    !input.identity.job_id || !input.identity.job_number ||
    !input.identity.authority_kind ||
    !input.identity.authority_revision_id ||
    !input.identity.source_instruction_id || !input.identity.lineage_id ||
    (input.identity.authority_kind === "effective_intake_case" &&
      !input.identity.case_id) ||
    !currentCycleId ||
    !sortedCycleIds.includes(currentCycleId) ||
    !isSha256Revision(currentCycleSetHash) ||
    !Number.isSafeInteger(input.source_version) ||
    Number(input.source_version) < 1 ||
    !isSha256Revision(input.source_content_hash) ||
    !Number.isSafeInteger(input.lineage_version) ||
    Number(input.lineage_version) < 1 ||
    !isSha256Revision(input.lineage_correction_hash) ||
    !isSha256Revision(input.lineage_supersession_hash)
  ) {
    diagnostics.push({
      code: "projection_input_error",
      severity: "hard",
      reason:
        "The source, lineage, job, or current attendance-cycle identity is incomplete.",
      evidence_refs: [
        input.identity.source_instruction_id,
        input.identity.case_id,
        input.identity.job_id,
        currentCycleId,
      ].filter((value): value is string => !!value),
    });
  }
  if (
    input.family_rule && (
      !input.family_rule.code || !input.family_rule.matrix_revision ||
      !isSha256Revision(input.family_rule.matrix_content_hash)
    )
  ) {
    diagnostics.push({
      code: "projection_input_error",
      severity: "hard",
      reason: "The make-safe family rule lacks immutable revision identity.",
      evidence_refs: [input.family_rule.code].filter(Boolean),
    });
  }
  if (
    input.workflow.docket_revision_id &&
    !isSha256Revision(input.workflow.docket_artifact_hash)
  ) {
    diagnostics.push({
      code: "projection_input_error",
      severity: "hard",
      reason: "The current docket lacks a content-addressed artifact hash.",
      evidence_refs: [input.workflow.docket_revision_id],
    });
  }
  validateAttendanceCycles(
    input.attendance_cycles,
    sortedCycleIds,
    diagnostics,
  );

  const assignments = stableCurrentFacts(
    input.assignments,
    currentCycleId,
    "assignment",
    diagnostics,
  ).filter((row) =>
    ACTIVE_ASSIGNMENT_STATUSES.has(String(row.status || "").toLowerCase())
  );
  const reports = stableCurrentFacts(
    input.service_reports,
    currentCycleId,
    "service report",
    diagnostics,
  ).filter((row) =>
    REPORT_STATUSES.has(String(row.status || "").toLowerCase())
  );
  const photos = stableCurrentFacts(
    input.completion_photos,
    currentCycleId,
    "completion photo",
    diagnostics,
  );
  const captures = stableCurrentFacts(
    input.portal_captures,
    currentCycleId,
    "portal capture",
    diagnostics,
  ).filter((row) =>
    ["captured", "verified"].includes(String(row.status || "").toLowerCase())
  );
  const documents = stableCurrentFacts(
    input.documents,
    currentCycleId,
    "document",
    diagnostics,
  );
  let readiness = readinessFromInput(
    input.readiness,
    currentCycleSetHash,
    diagnostics,
  );
  const projectionInputInvalid = diagnostics.some((item) =>
    item.code === "projection_input_error" && item.severity === "hard"
  );
  const authorityInputInvalid = projectionInputInvalid ||
    !!input.cycle_attribution_error;
  if (authorityInputInvalid && readiness.ready) {
    readiness = { ...readiness, state: "invalid", ready: false };
  }

  const terminalExact = !authorityInputInvalid &&
    input.terminal_proof.state === "valid" &&
    !!currentCycleId &&
    sameStrings(input.terminal_proof.attendance_cycle_ids, sortedCycleIds);
  const terminalProof: TerminalProofDimension = terminalExact
    ? input.terminal_proof
    : input.terminal_proof.state === "absent"
    ? emptyTerminalProof()
    : { ...input.terminal_proof, state: "superseded" };

  let handoffSatisfied = false;
  if (input.family_rule?.kind === "physical") {
    handoffSatisfied = reports.length > 0 &&
      photos.length >=
        (input.family_rule.completion_photo_floor ??
          MAKESAFE_COMPLETION_PHOTO_FLOOR_V2);
  } else if (input.family_rule) {
    const roles = new Set(captures.map((row) => String(row.role || "")));
    const documentTypes = new Set(
      documents.map((row) => String(row.role || "")),
    );
    handoffSatisfied = (input.family_rule.required_portal_roles || []).every(
      (role) => roles.has(role),
    ) &&
      (input.family_rule.required_document_types || []).every((type) => {
        const canonicalType = canonicalizeMakesafeDocumentRole(type);
        return canonicalType !== null && documentTypes.has(canonicalType);
      }) &&
      (reports.length > 0 || captures.length > 0 || documents.length > 0);
  }

  let stage: MakesafeV2OpsStage = "new";
  let stageReason =
    "No exact current-cycle assignment or completion handoff is recorded.";
  let stageEvidenceRefs = [
    input.identity.current_attendance_cycle_id,
    input.identity.job_id,
  ].filter((value): value is string => !!value);
  if (terminalExact) {
    if (input.terminal_proof.kind === "approved_nonwork_archive") {
      stage = "archive";
      stageReason =
        "An immutable non-work archive decision covers the exact attendance-cycle set.";
    } else {
      const age = input.terminal_proof.proven_at
        ? Date.parse(input.computed_at) -
          Date.parse(input.terminal_proof.proven_at)
        : Number.POSITIVE_INFINITY;
      stage = Number.isFinite(age) && age >= 0 && age <= 7 * 24 * 60 * 60 * 1000
        ? "completed"
        : "archive";
      stageReason =
        "Immutable closeout proof covers the exact attendance-cycle set.";
    }
    stageEvidenceRefs = [
      input.terminal_proof.proof_id,
      ...input.terminal_proof.evidence_refs,
    ].filter((value): value is string => !!value);
  } else if (readiness.ready && readiness.state === "ready") {
    stage = "report_ready";
    stageReason =
      "The current content-addressed readiness revision is valid and ready.";
    stageEvidenceRefs = [
      readiness.readiness_revision,
      readiness.attendance_cycle_set_hash,
    ].filter(Boolean) as string[];
  } else if (!authorityInputInvalid && handoffSatisfied) {
    stage = "trade_report_in";
    stageReason = input.family_rule?.kind === "physical"
      ? "A submitted current-cycle service report and the required completion photos are present."
      : "Every current-cycle portal/document role required by the family rule is present.";
    stageEvidenceRefs = input.family_rule?.kind === "physical"
      ? [...reports, ...photos].map((row) => row.id)
      : [...reports, ...captures, ...documents].map((row) => row.id);
  } else if (!authorityInputInvalid && assignments.length > 0) {
    stage = "allocated";
    stageReason =
      "An active assignment is bound to the exact current attendance cycle.";
    stageEvidenceRefs = assignments.map((row) => row.id);
  }

  const blockers: BlockerFact[] = [...input.operator_blockers];
  if (diagnostics.some((item) => item.severity === "hard")) {
    blockers.push(blocker(
      input,
      "projection_input_error",
      "Projection inputs are incomplete or not content-addressed.",
      "resolve_blocker",
      "Repair the identified source, lineage, cycle, family, or fact identity.",
      "system",
    ));
  }
  if (input.intake_exception) {
    blockers.push(blocker(
      input,
      "intake_exception",
      "The bound intake case remains unresolved.",
      "resolve_intake_exception",
      "Resolve the intake exception without fabricating a job or stage.",
    ));
  }
  if (!input.company_contact_present) {
    blockers.push(blocker(
      input,
      "company_contact_required",
      "Company contact is not recorded.",
      "contact_company",
      "Record the company contact outcome.",
      "ops",
      "warning",
    ));
  }
  if (!currentCycleId || input.cycle_attribution_error) {
    blockers.push(blocker(
      input,
      "backfill_cycle_scope",
      input.cycle_attribution_error ||
        "A current attendance cycle has not been established.",
      "bind_cycle_evidence",
      "Bind evidence to one exact current attendance cycle.",
    ));
  } else if (assignments.length === 0 && stage === "new") {
    blockers.push(blocker(
      input,
      "no_current_cycle_assignment",
      "No active assignment is bound to the current attendance cycle.",
      "allocate_trade",
      "Create or bind an active assignment to the current attendance cycle.",
      "ops",
      "warning",
    ));
  }
  if (assignments.length > 0 && !handoffSatisfied && input.family_rule) {
    if (
      input.family_rule.kind === "physical" && reports.length === 0
    ) {
      blockers.push(blocker(
        input,
        "missing_current_cycle_report",
        "No submitted or approved report is bound to the current attendance cycle.",
        "submit_trade_report",
        "Submit the current-cycle service report.",
        "trade",
        "warning",
      ));
    }
    if (
      input.family_rule.kind === "physical" &&
      photos.length <
        (input.family_rule.completion_photo_floor ??
          MAKESAFE_COMPLETION_PHOTO_FLOOR_V2)
    ) {
      blockers.push(blocker(
        input,
        "missing_current_cycle_photos",
        "The current attendance cycle has too few completion photos.",
        "submit_trade_report",
        "Attach the required current-cycle completion photos.",
        "trade",
        "warning",
        photos.map((row) => row.id),
      ));
    }
    if (
      input.family_rule.kind !== "physical" &&
      !handoffSatisfied
    ) {
      blockers.push(blocker(
        input,
        "missing_portal_capture",
        "The current-cycle portal evidence recipe is incomplete.",
        "submit_trade_report",
        "Capture every portal role required by the current family revision.",
        "trade",
        "warning",
      ));
    }
  }
  if (
    !input.family_rule && !terminalExact &&
    input.cancellation.state !== "confirmed"
  ) {
    blockers.push(blocker(
      input,
      "missing_family_rule",
      "The current family rule is absent.",
      "resolve_blocker",
      "Publish and bind a versioned family-matrix rule.",
    ));
  }
  if (!input.workflow.pricing_disposition_revision) {
    blockers.push(blocker(
      input,
      "missing_pricing_disposition",
      "The pricing disposition has no current revision.",
      "resolve_blocker",
      "Bind a pricing disposition revision before readiness.",
      "ops",
      "warning",
    ));
  }
  if (
    input.workflow.invoice_obligation_id &&
    !input.workflow.invoice_obligation_revision
  ) {
    blockers.push(blocker(
      input,
      "missing_invoice_obligation_revision",
      "The invoice obligation lacks its revision.",
      "resolve_blocker",
      "Bind the exact invoice-obligation revision.",
    ));
  }
  if (handoffSatisfied && !input.workflow.docket_revision_id) {
    blockers.push(blocker(
      input,
      "missing_pack_revision",
      "The completion handoff has no current docket revision.",
      "prepare_docket",
      "Prepare a docket bound to the current readiness dependencies.",
      "ops",
      "warning",
    ));
  }
  if (
    input.readiness.readiness_revision && !readiness.ready &&
    input.workflow.docket_revision_id
  ) {
    blockers.push(blocker(
      input,
      "stale_readiness_revision",
      "The stored readiness revision is invalidated or superseded.",
      "prepare_docket",
      "Recompute readiness against the current dependency generation.",
    ));
  }
  if (input.workflow.stale_approval) {
    blockers.push(blocker(
      input,
      "stale_approval",
      "An approval does not match the current readiness generation.",
      "review_docs",
      "Review and approve the exact current revision.",
    ));
  }
  if (input.workflow.money_review_required) {
    blockers.push(blocker(
      input,
      "money_review_required",
      "A commercial decision requires Captain review.",
      "approve_invoice",
      "Review the current pricing and invoice obligation.",
      "captain",
    ));
  }
  if (input.cancellation.state === "requested") {
    blockers.push(blocker(
      input,
      "cancellation_review_required",
      "Cancellation is requested but not decided.",
      "review_cancellation",
      "Confirm or rescind the cancellation request.",
      "captain",
    ));
  }
  if (input.workflow.released && !terminalExact) {
    blockers.push(blocker(
      input,
      "terminal_proof_required",
      "Release occurred without exact-cycle terminal proof.",
      "verify_closeout",
      "Record immutable terminal proof for the exact attendance-cycle set.",
    ));
  }

  const raw = String(input.substatus_raw || "").trim();
  const substatus = (CANONICAL_MAKESAFE_SUBSTATUSES as readonly string[])
      .includes(raw)
    ? raw as CanonicalMakesafeSubstatus
    : null;
  if (raw && !substatus) {
    diagnostics.push({
      code: raw === "pending_allocation"
        ? "legacy_substatus"
        : "projection_input_error",
      severity: raw === "pending_allocation" ? "warning" : "hard",
      reason: raw === "pending_allocation"
        ? "Legacy pending_allocation is not a canonical v2 substatus."
        : `Unknown substatus ${raw}.`,
      evidence_refs: input.identity.job_id ? [input.identity.job_id] : [],
    });
  } else if (substatus) {
    const expected = expectedStageForSubstatus(substatus);
    if (stageRank(expected) > stageRank(stage)) {
      diagnostics.push({
        code: "substatus_ahead_of_facts",
        severity: "warning",
        reason:
          `Stored substatus suggests ${expected}, but facts derive ${stage}.`,
        evidence_refs: input.identity.job_id ? [input.identity.job_id] : [],
      });
    } else if (stageRank(expected) < stageRank(stage)) {
      diagnostics.push({
        code: "facts_ahead_of_substatus",
        severity: "warning",
        reason:
          `Facts derive ${stage}, ahead of stored substatus ${substatus}.`,
        evidence_refs: input.identity.job_id ? [input.identity.job_id] : [],
      });
    }
  }

  const cancellation = input.cancellation || emptyCancellation();
  const primary = blockers.find((item) => item.severity === "hard") ||
    blockers[0] || null;
  return {
    contract_version: MAKESAFE_STATE_CONTRACT_VERSION,
    computed_at: input.computed_at,
    identity: {
      ...input.identity,
      attendance_cycle_ids: sortedCycleIds,
    },
    substatus,
    ops_stage: stage,
    ops_label: MAKESAFE_V2_OPS_LABELS[stage],
    trade_column: cancellation.state === "confirmed"
      ? "Archive"
      : MAKESAFE_V2_TRADE_COLUMNS[stage],
    stage_evidence: {
      determinate: !authorityInputInvalid,
      reason: authorityInputInvalid
        ? "The stage is not authoritative because required identity or cycle evidence is ambiguous."
        : stageReason,
      evidence_refs: authorityInputInvalid ? [] : stageEvidenceRefs,
    },
    readiness,
    blocker: {
      blocked: blockers.length > 0,
      primary,
      active: blockers,
    },
    cancellation,
    terminal_proof: terminalProof,
    next_action: selectNextAction(
      input,
      stage,
      blockers,
      assignments.length > 0,
      handoffSatisfied,
      terminalExact,
    ),
    diagnostics,
  };
}

export function diffV1V2State(
  v1Row: unknown,
  state: MakesafeStateV2,
): V1V2Diff {
  const v1 = (v1Row || {}) as Record<string, unknown>;
  const fields = [
    { path: "stage", v1: v1.canonical_stage ?? null, v2: state.ops_stage },
    {
      path: "label",
      v1: v1.canonical_stage_label ?? null,
      v2: state.ops_label,
    },
    { path: "substatus", v1: v1.substatus ?? null, v2: state.substatus },
    {
      path: "attendance_cycle_id",
      v1: v1.attendance_cycle_id ?? null,
      v2: state.identity.current_attendance_cycle_id,
    },
    {
      path: "readiness_revision",
      v1: v1.readiness_revision ?? null,
      v2: state.readiness.readiness_revision,
    },
    {
      path: "cancellation",
      v1: v1.cancelled ? "confirmed" : "none",
      v2: state.cancellation.state,
    },
  ].filter((item) => JSON.stringify(item.v1) !== JSON.stringify(item.v2));
  return { equal: fields.length === 0, fields };
}

export const EMPTY_CANCELLATION = emptyCancellation;
export const EMPTY_TERMINAL_PROOF = emptyTerminalProof;
