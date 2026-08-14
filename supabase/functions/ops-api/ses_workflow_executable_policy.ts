/**
 * Low-level executable SES family policy.
 *
 * These operands are consumed by more than one runtime surface. Keeping their
 * exact role programs and deliverable-authority rule here prevents an adapter,
 * pack-prep, stage-engine, or registry-local literal from becoming a second
 * canon whose behavior can drift without moving the workflow contract hash.
 */
export const SES_WORKFLOW_EXECUTABLE_POLICY_VERSION =
  "ses-workflow-executable-policy/2026-08-15.2";

export const SES_STAGE_TRUSTED_COMPLETION_SOURCE_IDS = [
  "terminal_proof.proven_at",
  "pack.sent_at",
  "invoice.invoice_date",
  "invoice.created_at",
  "jobs.completed_at",
  "detail.report_sent_at",
] as const;

export type SesStageTrustedCompletionSourceId =
  (typeof SES_STAGE_TRUSTED_COMPLETION_SOURCE_IDS)[number];

/**
 * Every closed stage-engine vocabulary and threshold that can move a card.
 *
 * The stage engine consumes this object directly and the workflow registry
 * fingerprints the same object. A status, threshold, precedence list or
 * decision vocabulary therefore cannot change independently of the canonical
 * workflow coordinate.
 */
export const SES_STAGE_EXECUTABLE_POLICY = Object.freeze({
  completed_window_ms: 7 * 86_400_000,
  trusted_completion_source_order: Object.freeze([
    ...SES_STAGE_TRUSTED_COMPLETION_SOURCE_IDS,
  ]),
  issued_invoice_statuses: Object.freeze(
    [
      "AUTHORISED",
      "SUBMITTED",
      "PAID",
    ] as const,
  ),
  contract_states: Object.freeze(
    [
      "sealed",
      "known_unsealed",
      "unsupported",
    ] as const,
  ),
  cancelled_job_statuses: Object.freeze(["cancelled", "canceled"] as const),
  archived_job_statuses: Object.freeze(["archived"] as const),
  claimed_terminal_job_statuses: Object.freeze(
    [
      "complete",
      "completed",
      "closed",
    ] as const,
  ),
  own_document_submitted_statuses: Object.freeze(["submitted"] as const),
  service_report_submitted_statuses: Object.freeze(
    [
      "submitted",
      "approved",
    ] as const,
  ),
  docs_ready: Object.freeze({
    recorded_ready_states: Object.freeze(["READY"] as const),
    legacy_recorded_states: Object.freeze(["", "DRAFTED"] as const),
    legacy_pack_statuses: Object.freeze(["drafted"] as const),
    already_sent_pack_statuses: Object.freeze(
      [
        "sent",
        "sent_marker_failed",
        "sent_not_closed",
        "close_failed",
      ] as const,
    ),
  }),
  portal: Object.freeze({
    capture_not_done_statuses: Object.freeze(["not_done"] as const),
    capture_unreachable_statuses: Object.freeze(["unreachable"] as const),
    cannot_observe_outcome: "cannot_observe" as const,
  }),
  evidence_stage: Object.freeze({
    unsent_pack_ready: "report_ready" as const,
    empty: "new" as const,
  }),
  overlay: Object.freeze({
    default_decision_kind: "display_override" as const,
    admitted_decision_kinds: Object.freeze(
      [
        "display_override",
        "stage_attestation",
      ] as const,
    ),
    report_ready_status: "report_ready" as const,
  }),
});

export type SesExecutableFamilyId =
  | "physical_makesafe"
  | "ordinary_roof_portal"
  | "own_template_roof"
  | "assessment_quote"
  | "temporary_fencing"
  | "repair"
  | "restoration";

export type SesDeliverableAuthorityPolicy =
  | "legacy_instruction_or_case"
  | "persisted_effective_case_required";

export type SesPreparePortalRole =
  | "roof_report"
  | "assessment"
  | "photos"
  | "scope";

export type SesStagePortalRole =
  | "roof_report"
  | "assessment_report"
  | "photos"
  | "quote";

export type SesPortalArtifactRole =
  | "roof_portal_capture"
  | "assessment_report"
  | "photos"
  | "quote";

export interface SesPortalRoleProgram {
  prepare_role: SesPreparePortalRole;
  stage_role: SesStagePortalRole;
  artifact_role: SesPortalArtifactRole;
}

export interface SesWorkflowExecutableFamilyPolicy {
  deliverable_authority: SesDeliverableAuthorityPolicy;
  portal_roles: readonly SesPortalRoleProgram[];
}

const NO_PORTAL_ROLES = Object.freeze([]) as readonly SesPortalRoleProgram[];

const ROOF_PORTAL_ROLES = Object.freeze([
  Object.freeze({
    prepare_role: "roof_report",
    stage_role: "roof_report",
    artifact_role: "roof_portal_capture",
  }),
]) satisfies readonly SesPortalRoleProgram[];

const ASSESSMENT_PORTAL_ROLES = Object.freeze([
  Object.freeze({
    prepare_role: "assessment",
    stage_role: "assessment_report",
    artifact_role: "assessment_report",
  }),
  Object.freeze({
    prepare_role: "photos",
    stage_role: "photos",
    artifact_role: "photos",
  }),
  Object.freeze({
    prepare_role: "scope",
    stage_role: "quote",
    artifact_role: "quote",
  }),
]) satisfies readonly SesPortalRoleProgram[];

function policy(
  deliverableAuthority: SesDeliverableAuthorityPolicy,
  portalRoles: readonly SesPortalRoleProgram[] = NO_PORTAL_ROLES,
): SesWorkflowExecutableFamilyPolicy {
  return Object.freeze({
    deliverable_authority: deliverableAuthority,
    portal_roles: portalRoles,
  });
}

export const SES_WORKFLOW_EXECUTABLE_FAMILY_POLICY: Readonly<
  Record<SesExecutableFamilyId, SesWorkflowExecutableFamilyPolicy>
> = Object.freeze({
  physical_makesafe: policy("legacy_instruction_or_case"),
  ordinary_roof_portal: policy(
    "legacy_instruction_or_case",
    ROOF_PORTAL_ROLES,
  ),
  own_template_roof: policy("legacy_instruction_or_case"),
  assessment_quote: policy(
    "legacy_instruction_or_case",
    ASSESSMENT_PORTAL_ROLES,
  ),
  temporary_fencing: policy("legacy_instruction_or_case"),
  repair: policy("persisted_effective_case_required"),
  restoration: policy("persisted_effective_case_required"),
});

export function sesWorkflowExecutableFamilyPolicy(
  family: SesExecutableFamilyId,
): SesWorkflowExecutableFamilyPolicy {
  return SES_WORKFLOW_EXECUTABLE_FAMILY_POLICY[family];
}

export function sesFamilyRequiresPersistedDeliverableAuthority(
  family: SesExecutableFamilyId,
): boolean {
  return sesDeliverableAuthorityRequiresPersistedCase(
    sesWorkflowExecutableFamilyPolicy(family).deliverable_authority,
  );
}

export function sesDeliverableAuthorityRequiresPersistedCase(
  policy: SesDeliverableAuthorityPolicy,
): boolean {
  return policy ===
    "persisted_effective_case_required";
}

export function sesPreparePortalRoles(
  family: SesExecutableFamilyId,
): readonly SesPreparePortalRole[] {
  return sesWorkflowExecutableFamilyPolicy(family).portal_roles.map((role) =>
    role.prepare_role
  );
}

export function sesStagePortalRoles(
  family: SesExecutableFamilyId,
): readonly SesStagePortalRole[] {
  return sesWorkflowExecutableFamilyPolicy(family).portal_roles.map((role) =>
    role.stage_role
  );
}

export function sesPortalArtifactRoles(
  family: SesExecutableFamilyId,
): readonly SesPortalArtifactRole[] {
  return sesWorkflowExecutableFamilyPolicy(family).portal_roles.map((role) =>
    role.artifact_role
  );
}
