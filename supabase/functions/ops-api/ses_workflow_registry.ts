import {
  canonicalSesJson,
  SES_ASSEMBLER_VERSION,
  SES_DOCKET_ENVELOPE_VERSION,
  SES_MANIFEST_V2_VERSION,
  type SesSha256,
  sesSha256,
} from "./ses_docket_envelope.ts";
import {
  resolveSesFamilyMatrixRow,
  SES_FAMILY_MATRIX,
  SES_FAMILY_MATRIX_EXECUTABLE_POLICY,
  SES_FAMILY_MATRIX_VERSION,
  type SesBuilderKey,
  type SesFamilyId,
  type SesFamilyMatrixRow,
  type SesInvoiceBasis,
} from "./ses_family_matrix.ts";
import {
  SES_DOCKET_REVIEW_SPEC_VERSION,
  SES_PACK_PREPARATION_EXECUTABLE_POLICY,
  SES_WORKFLOW_PRICING_EXECUTABLE_POLICY,
  SES_WORKFLOW_PRICING_RULE_VERSION,
  type SesWorkflowArtifactProfileId,
  type SesWorkflowArtifactRole,
  sesWorkflowPackProfile,
  type SesWorkflowPackProfileId,
  sesWorkflowPricingProfile,
} from "./ses_prepare_docket_revision.ts";
import {
  SES_WORKFLOW_SEND_EXECUTION_POLICY,
  SES_WORKFLOW_SEND_RULE_VERSION,
  sesWorkflowSendProfile,
  type SesWorkflowSendProfileId,
} from "./ses_release_route_shape.ts";
import {
  SES_STAGE_ENGINE_V2_VERSION,
  sesStageWorkflowProfile,
  type SesStageWorkflowProfileId,
} from "./ses_stage_engine_v2.ts";
import {
  SES_STAGE_EXECUTABLE_POLICY,
  SES_WORKFLOW_EXECUTABLE_FAMILY_POLICY,
  SES_WORKFLOW_EXECUTABLE_POLICY_VERSION,
  type SesDeliverableAuthorityPolicy,
  sesDeliverableAuthorityRequiresPersistedCase,
  sesPortalArtifactRoles,
  sesPreparePortalRoles,
  sesStagePortalRoles,
  type SesWorkflowExecutableFamilyPolicy,
  sesWorkflowExecutableFamilyPolicy,
} from "./ses_workflow_executable_policy.ts";
import {
  SES_WORKFLOW_EXECUTABLE_ENTRY_POINTS,
  SES_WORKFLOW_SOURCE_CLOSURE_BOUNDARY_VERSION,
  type SesWorkflowExecutableSourceClosure,
  sesWorkflowExecutableSourceClosure,
} from "./ses_workflow_source_closure.ts";
import contractLock from "./ses_workflow_contract_lock.json" with {
  type: "json",
};

export const SES_WORKFLOW_CONTRACT_SCHEMA_VERSION =
  "secureworks.ses-workflow-contract/v1";
export const SES_WORKFLOW_CONTRACT_CANON_REVISION =
  "ses-workflow-contract/2026-08-15.5";
export const SES_WORKFLOW_RELEASE_CONTRACT_VERSION =
  "ses-release-contract/v1-preflight-only";
export const SES_WORKFLOW_CONTRACT_HASH_DOMAIN =
  "SecureWorks:ses-workflow-contract:v1\n";

/**
 * Pinned semantic hash. The focused test independently recomputes this from
 * the executable registry, so a contract change must be deliberate and
 * review-visible rather than silently moving the drift-test coordinate.
 */
export const SES_WORKFLOW_CONTRACT_CANONICAL_HASH: SesSha256 = contractLock
  .canonical_contract_hash as SesSha256;

export const SES_WORKFLOW_PUBLIC_FAMILIES = [
  "physical_makesafe",
  "roof",
  "assessment",
  "temporary_fence",
  "repair",
  "restoration",
] as const;
export type SesWorkflowFamilyId = (typeof SES_WORKFLOW_PUBLIC_FAMILIES)[number];

export type SesWorkflowDeliveryVariant =
  | "standard"
  | "portal"
  | "own_document";
export type SesWorkflowRegionQualifier =
  | "default"
  | "perth"
  | "south_west";
export type SesWorkflowSealState = "sealed" | "unsealed";
export type SesWorkflowUnsealedReason =
  | "report_only_envelope_unsettled"
  | "synthetic_release_forbidden"
  | "release_contract_preflight_only";

export const SES_WORKFLOW_EXECUTABLE_OPERAND_IDS = [
  "source.transitive_module_closure",
  "family.matrix_rows",
  "family.selection_policy",
  "family.runtime_policy",
  "stage.global_policy",
  "stage.family_profiles",
  "pack.global_policy",
  "pack.family_profiles",
  "pricing.global_policy",
  "pricing.basis_profiles",
  "send.global_policy",
  "send.variant_profiles",
] as const;

export type SesWorkflowExecutableOperandId =
  (typeof SES_WORKFLOW_EXECUTABLE_OPERAND_IDS)[number];

export type SesWorkflowExecutableOperandRegistry = Readonly<
  Record<SesWorkflowExecutableOperandId, unknown>
>;

interface SesWorkflowProfileBase {
  profile_id: string;
  seal_state: SesWorkflowSealState;
  unsealed_reason_code: SesWorkflowUnsealedReason | null;
  source_rule_ids: readonly string[];
  contract_hash: SesSha256;
}

export interface SesWorkflowFamilyProfile extends SesWorkflowProfileBase {
  profile_id: `family.${SesWorkflowFamilyId}.v1`;
  family_id: SesWorkflowFamilyId;
  deliverable_authority_policy: SesDeliverableAuthorityPolicy;
  active_deliverable_required: boolean;
}

export interface SesWorkflowArtifactProfile extends SesWorkflowProfileBase {
  profile_id: SesWorkflowArtifactProfileId;
  included_artifacts: readonly SesWorkflowArtifactRole[];
  hard_required_artifacts: readonly SesWorkflowArtifactRole[];
  forbidden_artifacts: readonly SesWorkflowArtifactRole[];
  swms_generation: "generated_scope_correct";
  swms_requirement:
    | "hard_required"
    | "include_not_required_until_accuracy_gate";
}

export interface SesWorkflowStageProfile extends SesWorkflowProfileBase {
  profile_id: SesStageWorkflowProfileId;
  stage_engine_version: string;
  evidence_kind: string;
  required_portal_roles: readonly string[];
  own_document_evidence_required: boolean;
  executable_stage_policy: typeof SES_STAGE_EXECUTABLE_POLICY;
}

export interface SesWorkflowPackProfile extends SesWorkflowProfileBase {
  profile_id: SesWorkflowPackProfileId;
  artifact_profile_id: SesWorkflowArtifactProfileId;
  assembler_version: string;
  docket_envelope_version: string;
  manifest_version: string;
  review_spec_version: string;
  prepare_only: true;
  detect_before_mint: true;
  bind_order: readonly string[];
}

export interface SesWorkflowPricingProfile extends SesWorkflowProfileBase {
  profile_id: `pricing.${SesInvoiceBasis}.v1`;
  invoice_basis: SesInvoiceBasis;
  family_matrix_version: string;
  pricing_rule_version: string;
  executable_semantics: Record<string, unknown>;
  unknown_builder_default: false;
}

export interface SesWorkflowSendProfile extends SesWorkflowProfileBase {
  profile_id: SesWorkflowSendProfileId;
  executable_send_recipe_id: SesWorkflowSendProfileId | null;
  route_order: readonly string[];
  send_rule_version: string;
  executable_semantics: Record<string, unknown>;
  live_effects_enabled: false;
  atomic_release_gate: "required_before_live_release";
}

export interface SesWorkflowEffectiveVariant {
  variant_id: string;
  family_id: SesWorkflowFamilyId;
  runtime_family_id: Exclude<SesFamilyId, "unknown">;
  builder_key: Exclude<SesBuilderKey, "UNKNOWN">;
  delivery_variant: SesWorkflowDeliveryVariant;
  region_qualifier: SesWorkflowRegionQualifier;
  routing_rule: SesFamilyMatrixRow["routing_rule"];
  /** Exact executable matrix row consumed by adapter, prepare, pricing and send. */
  executable_matrix_row: SesFamilyMatrixRow;
  /** Complete low-level family operand consumed across adapter/prepare/stage. */
  executable_family_policy: SesWorkflowExecutableFamilyPolicy;
  family_profile_id: SesWorkflowFamilyProfile["profile_id"];
  artifact_profile_id: SesWorkflowArtifactProfileId;
  stage_profile_id: SesStageWorkflowProfileId;
  pack_profile_id: SesWorkflowPackProfileId;
  pricing_profile_id: SesWorkflowPricingProfile["profile_id"];
  /** Executable release pointer. Section 6.3 requires null while unsealed. */
  send_recipe_id: SesWorkflowSendProfileId | null;
  /** Non-executable diagnostic expectation used to complete/inspect the chain. */
  expected_send_profile_id: SesWorkflowSendProfileId;
  release_contract_version: string;
  backend_policy_seal_state: SesWorkflowSealState;
  seal_state: SesWorkflowSealState;
  unsealed_reason_code: SesWorkflowUnsealedReason | null;
  release_prerequisites: {
    release_contract_enabled: false;
    wiki_backend_hash_agreed: false;
    atomic_release_lease_satisfied: false;
  };
  live_release_enabled: false;
  contract_hash: SesSha256;
}

export interface SesWorkflowContractManifest {
  schema_version: typeof SES_WORKFLOW_CONTRACT_SCHEMA_VERSION;
  canon_revision: typeof SES_WORKFLOW_CONTRACT_CANON_REVISION;
  release_contract_version: typeof SES_WORKFLOW_RELEASE_CONTRACT_VERSION;
  source_versions: {
    family_matrix: string;
    stage_engine: string;
    assembler: string;
    docket_envelope: string;
    manifest: string;
    review_spec: string;
    pricing_rules: string;
    send_rules: string;
    executable_policy: string;
  };
  executable_policy: SesWorkflowExecutableOperandRegistry;
  profiles: {
    family: readonly SesWorkflowFamilyProfile[];
    artifact: readonly SesWorkflowArtifactProfile[];
    stage: readonly SesWorkflowStageProfile[];
    pack: readonly SesWorkflowPackProfile[];
    pricing: readonly SesWorkflowPricingProfile[];
    send: readonly SesWorkflowSendProfile[];
  };
  variants: readonly SesWorkflowEffectiveVariant[];
  canonical_contract_hash: SesSha256;
}

type RawProfile<T extends SesWorkflowProfileBase> = Omit<T, "contract_hash">;
type RawVariant = Omit<SesWorkflowEffectiveVariant, "contract_hash">;
type RawManifest =
  & Omit<
    SesWorkflowContractManifest,
    "profiles" | "variants" | "canonical_contract_hash"
  >
  & {
    profiles: {
      family: readonly RawProfile<SesWorkflowFamilyProfile>[];
      artifact: readonly RawProfile<SesWorkflowArtifactProfile>[];
      stage: readonly RawProfile<SesWorkflowStageProfile>[];
      pack: readonly RawProfile<SesWorkflowPackProfile>[];
      pricing: readonly RawProfile<SesWorkflowPricingProfile>[];
      send: readonly RawProfile<SesWorkflowSendProfile>[];
    };
    variants: readonly RawVariant[];
  };

const SES_WORKFLOW_VARIANT_SHAPE_SOURCE_CLOSURE = Object.freeze({
  boundary_version: SES_WORKFLOW_SOURCE_CLOSURE_BOUNDARY_VERSION,
  entry_points: SES_WORKFLOW_EXECUTABLE_ENTRY_POINTS,
  module_count: 0,
  modules: Object.freeze({}),
  closure_sha256: `sha256:${"0".repeat(64)}` as SesSha256,
}) satisfies SesWorkflowExecutableSourceClosure;

function sortedStrings<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(codePointCompare);
}

function sortedProfiles<T extends { profile_id: string }>(values: T[]): T[] {
  return values.sort((a, b) => codePointCompare(a.profile_id, b.profile_id));
}

function codePointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function setConsistentProfile<T extends { profile_id: string }>(
  profiles: Map<string, T>,
  profile: T,
): void {
  const existing = profiles.get(profile.profile_id);
  if (
    existing && canonicalSesJson(existing) !== canonicalSesJson(profile)
  ) {
    throw new Error(
      `workflow profile ${profile.profile_id} resolves to divergent executable operands`,
    );
  }
  profiles.set(profile.profile_id, profile);
}

function publicFamilyId(row: SesFamilyMatrixRow): SesWorkflowFamilyId {
  switch (row.family) {
    case "physical_makesafe":
      return "physical_makesafe";
    case "ordinary_roof_portal":
    case "own_template_roof":
      return "roof";
    case "assessment_quote":
      return "assessment";
    case "temporary_fencing":
      return "temporary_fence";
    case "repair":
      return "repair";
    case "restoration":
      return "restoration";
    case "unknown":
      throw new Error("unknown SES family cannot enter the workflow registry");
    default: {
      const exhaustive: never = row.family;
      throw new Error(`unhandled SES registry family: ${String(exhaustive)}`);
    }
  }
}

function deliveryVariant(
  row: SesFamilyMatrixRow,
): SesWorkflowDeliveryVariant {
  if (
    row.family === "ordinary_roof_portal" || row.family === "assessment_quote"
  ) {
    return "portal";
  }
  if (row.family === "own_template_roof") return "own_document";
  return "standard";
}

function regionQualifier(
  row: SesFamilyMatrixRow,
): SesWorkflowRegionQualifier {
  if (row.routing_rule === "mlb-south-west-routing") return "south_west";
  if (row.routing_rule === "mlb-perth-routing") return "perth";
  return "default";
}

function effectiveVariantId(row: SesFamilyMatrixRow): string {
  return [
    publicFamilyId(row),
    deliveryVariant(row),
    row.builder_key.toLowerCase(),
    regionQualifier(row),
  ].join(".");
}

function familyProfile(
  familyId: SesWorkflowFamilyId,
  runtimeFamilyId: Exclude<SesFamilyId, "unknown">,
): RawProfile<SesWorkflowFamilyProfile> {
  const deliverableAuthority = sesWorkflowExecutableFamilyPolicy(
    runtimeFamilyId,
  ).deliverable_authority;
  return {
    profile_id: `family.${familyId}.v1`,
    family_id: familyId,
    deliverable_authority_policy: deliverableAuthority,
    active_deliverable_required: sesDeliverableAuthorityRequiresPersistedCase(
      deliverableAuthority,
    ),
    seal_state: "sealed",
    unsealed_reason_code: null,
    source_rule_ids: sortedStrings([
      `family.${familyId}.applicability.v1`,
      `family.matrix.${SES_FAMILY_MATRIX_VERSION}`,
    ]),
  };
}

function executableMatrixRow(row: SesFamilyMatrixRow): SesFamilyMatrixRow {
  return {
    ...row,
    required_portal_roles: [...row.required_portal_roles],
    named_na_rules: [...row.named_na_rules],
  };
}

function executableFamilyPolicy(
  family: Exclude<SesFamilyId, "unknown">,
): SesWorkflowExecutableFamilyPolicy {
  const policy = sesWorkflowExecutableFamilyPolicy(family);
  return {
    ...policy,
    portal_roles: policy.portal_roles.map((role) => ({ ...role })),
  };
}

export function assertSesWorkflowExecutablePolicyConsistency(
  row: SesFamilyMatrixRow,
): void {
  if (row.family === "unknown") {
    throw new Error("unknown SES family cannot enter executable policy checks");
  }
  const packDescriptor = sesWorkflowPackProfile(row.family);
  const stageDescriptor = sesStageWorkflowProfile(row.family);
  if (!packDescriptor || !stageDescriptor) {
    throw new Error(`known SES family ${row.family} has no workflow profile`);
  }
  const prepareRoles = sesPreparePortalRoles(row.family);
  const stageRoles = sesStagePortalRoles(row.family);
  const artifactRoles = sesPortalArtifactRoles(row.family);
  if (
    canonicalSesJson(row.required_portal_roles) !==
      canonicalSesJson(prepareRoles)
  ) {
    throw new Error(
      `family matrix ${row.builder_key}/${row.family}/${row.routing_rule} portal roles diverge from the executable portal-role owner`,
    );
  }
  if (
    canonicalSesJson(stageDescriptor.required_portal_roles) !==
      canonicalSesJson(stageRoles)
  ) {
    throw new Error(
      `stage profile ${stageDescriptor.profile_id} portal roles diverge from the executable portal-role owner`,
    );
  }
  if (
    artifactRoles.some((role) =>
      !packDescriptor.included_artifacts.includes(role) ||
      !packDescriptor.hard_required_artifacts.includes(role)
    )
  ) {
    throw new Error(
      `pack profile ${packDescriptor.pack_profile_id} portal artifacts diverge from the executable portal-role owner`,
    );
  }
}

function pricingProfile(
  invoiceBasis: SesInvoiceBasis,
): RawProfile<SesWorkflowPricingProfile> {
  const descriptor = sesWorkflowPricingProfile(invoiceBasis);
  return {
    profile_id: descriptor.profile_id,
    invoice_basis: invoiceBasis,
    family_matrix_version: SES_FAMILY_MATRIX_VERSION,
    pricing_rule_version: descriptor.pricing_rule_version,
    executable_semantics: descriptor.executable_semantics,
    unknown_builder_default: false,
    seal_state: "sealed",
    unsealed_reason_code: null,
    source_rule_ids: sortedStrings([
      ...descriptor.source_rule_ids,
      "pricing.canonical-reference-owned.v1",
    ]),
  };
}

function buildExecutableOperandRegistry(
  sourceClosure: SesWorkflowExecutableSourceClosure,
): SesWorkflowExecutableOperandRegistry {
  const runtimeFamilies = Object.keys(
    SES_WORKFLOW_EXECUTABLE_FAMILY_POLICY,
  ) as Array<Exclude<SesFamilyId, "unknown">>;
  const invoiceBases = [
    ...new Set(SES_FAMILY_MATRIX.map((row) => row.invoice_basis)),
  ].sort(codePointCompare);
  const sendProfiles = SES_FAMILY_MATRIX.map((row) => ({
    builder_key: row.builder_key,
    family: row.family,
    routing_rule: row.routing_rule,
    profile: sesWorkflowSendProfile(row),
  })).sort((left, right) =>
    codePointCompare(
      `${left.builder_key}.${left.family}.${left.routing_rule}`,
      `${right.builder_key}.${right.family}.${right.routing_rule}`,
    )
  );
  return Object.freeze(
    {
      "source.transitive_module_closure": sourceClosure,
      "family.matrix_rows": SES_FAMILY_MATRIX.map(executableMatrixRow),
      "family.selection_policy": SES_FAMILY_MATRIX_EXECUTABLE_POLICY,
      "family.runtime_policy": SES_WORKFLOW_EXECUTABLE_FAMILY_POLICY,
      "stage.global_policy": SES_STAGE_EXECUTABLE_POLICY,
      "stage.family_profiles": runtimeFamilies.map((family) => ({
        family,
        profile: sesStageWorkflowProfile(family),
      })),
      "pack.global_policy": SES_PACK_PREPARATION_EXECUTABLE_POLICY,
      "pack.family_profiles": runtimeFamilies.map((family) => ({
        family,
        profile: sesWorkflowPackProfile(family),
      })),
      "pricing.global_policy": SES_WORKFLOW_PRICING_EXECUTABLE_POLICY,
      "pricing.basis_profiles": invoiceBases.map((invoiceBasis) => ({
        invoice_basis: invoiceBasis,
        profile: sesWorkflowPricingProfile(invoiceBasis),
      })),
      "send.global_policy": SES_WORKFLOW_SEND_EXECUTION_POLICY,
      "send.variant_profiles": sendProfiles,
    } satisfies Record<SesWorkflowExecutableOperandId, unknown>,
  );
}

function buildRawManifest(
  sourceClosure: SesWorkflowExecutableSourceClosure,
): RawManifest {
  const family = new Map<string, RawProfile<SesWorkflowFamilyProfile>>();
  const artifact = new Map<string, RawProfile<SesWorkflowArtifactProfile>>();
  const stage = new Map<string, RawProfile<SesWorkflowStageProfile>>();
  const pack = new Map<string, RawProfile<SesWorkflowPackProfile>>();
  const pricing = new Map<string, RawProfile<SesWorkflowPricingProfile>>();
  const send = new Map<string, RawProfile<SesWorkflowSendProfile>>();
  const variants: RawVariant[] = [];

  for (const row of SES_FAMILY_MATRIX) {
    if (row.family === "unknown") {
      throw new Error("unknown SES family cannot enter the workflow registry");
    }
    const familyId = publicFamilyId(row);
    const packDescriptor = sesWorkflowPackProfile(row.family);
    const stageDescriptor = sesStageWorkflowProfile(row.family);
    if (!packDescriptor || !stageDescriptor) {
      throw new Error(`known SES family ${row.family} has no workflow profile`);
    }
    assertSesWorkflowExecutablePolicyConsistency(row);
    const familyDescriptor = familyProfile(familyId, row.family);
    setConsistentProfile(family, familyDescriptor);
    setConsistentProfile(artifact, {
      profile_id: packDescriptor.artifact_profile_id,
      included_artifacts: sortedStrings(packDescriptor.included_artifacts),
      hard_required_artifacts: sortedStrings(
        packDescriptor.hard_required_artifacts,
      ),
      forbidden_artifacts: sortedStrings(packDescriptor.forbidden_artifacts),
      swms_generation: packDescriptor.swms_generation,
      swms_requirement: packDescriptor.swms_requirement,
      seal_state: "sealed",
      unsealed_reason_code: null,
      source_rule_ids: sortedStrings(packDescriptor.source_rule_ids),
    });
    setConsistentProfile(pack, {
      profile_id: packDescriptor.pack_profile_id,
      artifact_profile_id: packDescriptor.artifact_profile_id,
      assembler_version: SES_ASSEMBLER_VERSION,
      docket_envelope_version: SES_DOCKET_ENVELOPE_VERSION,
      manifest_version: SES_MANIFEST_V2_VERSION,
      review_spec_version: SES_DOCKET_REVIEW_SPEC_VERSION,
      prepare_only: true,
      detect_before_mint: packDescriptor.detect_before_mint,
      bind_order: [...packDescriptor.bind_order],
      seal_state: "sealed",
      unsealed_reason_code: null,
      source_rule_ids: sortedStrings(packDescriptor.source_rule_ids),
    });
    setConsistentProfile(stage, {
      profile_id: stageDescriptor.profile_id,
      stage_engine_version: SES_STAGE_ENGINE_V2_VERSION,
      evidence_kind: stageDescriptor.evidence_kind,
      required_portal_roles: sortedStrings(
        stageDescriptor.required_portal_roles,
      ),
      own_document_evidence_required:
        stageDescriptor.own_document_evidence_required,
      executable_stage_policy: SES_STAGE_EXECUTABLE_POLICY,
      seal_state: "sealed",
      unsealed_reason_code: null,
      source_rule_ids: sortedStrings(stageDescriptor.source_rule_ids),
    });

    const pricingDescriptor = pricingProfile(row.invoice_basis);
    setConsistentProfile(pricing, pricingDescriptor);
    const sendDescriptor = sesWorkflowSendProfile(row);
    setConsistentProfile(send, {
      profile_id: sendDescriptor.profile_id,
      executable_send_recipe_id: sendDescriptor.executable_send_recipe_id,
      route_order: [...sendDescriptor.route_order],
      send_rule_version: sendDescriptor.send_rule_version,
      executable_semantics: sendDescriptor.executable_semantics,
      live_effects_enabled: false,
      atomic_release_gate: sendDescriptor.atomic_release_gate,
      seal_state: sendDescriptor.seal_state,
      unsealed_reason_code: sendDescriptor.unsealed_reason_code,
      source_rule_ids: sortedStrings(sendDescriptor.source_rule_ids),
    });
    variants.push({
      variant_id: effectiveVariantId(row),
      family_id: familyId,
      runtime_family_id: row.family,
      builder_key: row.builder_key,
      delivery_variant: deliveryVariant(row),
      region_qualifier: regionQualifier(row),
      routing_rule: row.routing_rule,
      executable_matrix_row: executableMatrixRow(row),
      executable_family_policy: executableFamilyPolicy(row.family),
      family_profile_id: familyDescriptor.profile_id,
      artifact_profile_id: packDescriptor.artifact_profile_id,
      stage_profile_id: stageDescriptor.profile_id,
      pack_profile_id: packDescriptor.pack_profile_id,
      pricing_profile_id: pricingDescriptor.profile_id,
      send_recipe_id: null,
      expected_send_profile_id: sendDescriptor.profile_id,
      release_contract_version: SES_WORKFLOW_RELEASE_CONTRACT_VERSION,
      backend_policy_seal_state: sendDescriptor.seal_state,
      seal_state: "unsealed",
      unsealed_reason_code: sendDescriptor.unsealed_reason_code ||
        "release_contract_preflight_only",
      release_prerequisites: {
        release_contract_enabled: false,
        wiki_backend_hash_agreed: false,
        atomic_release_lease_satisfied: false,
      },
      live_release_enabled: false,
    });
  }

  return {
    schema_version: SES_WORKFLOW_CONTRACT_SCHEMA_VERSION,
    canon_revision: SES_WORKFLOW_CONTRACT_CANON_REVISION,
    release_contract_version: SES_WORKFLOW_RELEASE_CONTRACT_VERSION,
    source_versions: {
      family_matrix: SES_FAMILY_MATRIX_VERSION,
      stage_engine: SES_STAGE_ENGINE_V2_VERSION,
      assembler: SES_ASSEMBLER_VERSION,
      docket_envelope: SES_DOCKET_ENVELOPE_VERSION,
      manifest: SES_MANIFEST_V2_VERSION,
      review_spec: SES_DOCKET_REVIEW_SPEC_VERSION,
      pricing_rules: SES_WORKFLOW_PRICING_RULE_VERSION,
      send_rules: SES_WORKFLOW_SEND_RULE_VERSION,
      executable_policy: SES_WORKFLOW_EXECUTABLE_POLICY_VERSION,
    },
    executable_policy: buildExecutableOperandRegistry(sourceClosure),
    profiles: {
      family: sortedProfiles([...family.values()]),
      artifact: sortedProfiles([...artifact.values()]),
      stage: sortedProfiles([...stage.values()]),
      pack: sortedProfiles([...pack.values()]),
      pricing: sortedProfiles([...pricing.values()]),
      send: sortedProfiles([...send.values()]),
    },
    variants: variants.sort((a, b) =>
      codePointCompare(a.variant_id, b.variant_id)
    ),
  };
}

export type SesWorkflowStageContractState =
  | "sealed"
  | "known_unsealed"
  | "unsupported";

export interface SesWorkflowStageContractResolution {
  state: SesWorkflowStageContractState;
  reason_code: string | null;
  variant_id: string | null;
}

let stageContractVariantsById: Map<string, RawVariant> | null = null;

/**
 * Resolve the persisted docket coordinate against the current executable
 * registry without trusting its stored seal label alone. The canonical stage
 * engine stays pure/synchronous; CI separately proves the pinned hash still
 * matches the runtime export.
 */
export function resolveSesWorkflowStageContractCoordinate(input: {
  runtime_family_id?: unknown;
  variant_id?: unknown;
  canonical_contract_hash?: unknown;
  stored_seal_state?: unknown;
}): SesWorkflowStageContractResolution {
  const runtimeFamilyId = String(input.runtime_family_id || "").trim();
  const variantId = String(input.variant_id || "").trim();
  const contractHash = String(input.canonical_contract_hash || "").trim();
  const storedSealState = String(input.stored_seal_state || "").trim();
  if (!runtimeFamilyId || !variantId || !contractHash || !storedSealState) {
    return {
      state: "unsupported",
      reason_code: "family_contract_incomplete",
      variant_id: variantId || null,
    };
  }
  if (contractHash !== SES_WORKFLOW_CONTRACT_CANONICAL_HASH) {
    return {
      state: "unsupported",
      reason_code: "family_contract_divergent",
      variant_id: variantId,
    };
  }
  stageContractVariantsById ??= new Map(
    buildRawManifest(SES_WORKFLOW_VARIANT_SHAPE_SOURCE_CLOSURE).variants.map(
      (variant) => [variant.variant_id, variant],
    ),
  );
  const variant = stageContractVariantsById.get(variantId);
  if (!variant || variant.runtime_family_id !== runtimeFamilyId) {
    return {
      state: "unsupported",
      reason_code: "unsupported_family_variant",
      variant_id: variantId,
    };
  }
  if (storedSealState !== variant.seal_state) {
    return {
      state: "unsupported",
      reason_code: "family_contract_divergent",
      variant_id: variantId,
    };
  }
  return variant.seal_state === "sealed"
    ? { state: "sealed", reason_code: null, variant_id: variantId }
    : {
      state: "known_unsealed",
      reason_code: variant.unsealed_reason_code || "family_contract_unsealed",
      variant_id: variantId,
    };
}

function withoutHash<T extends SesWorkflowProfileBase>(
  profile: T,
): RawProfile<T> {
  const { contract_hash: _contractHash, ...raw } = profile;
  return raw;
}

function rawManifestFromExport(
  manifest: SesWorkflowContractManifest,
): RawManifest {
  return {
    schema_version: manifest.schema_version,
    canon_revision: manifest.canon_revision,
    release_contract_version: manifest.release_contract_version,
    source_versions: { ...manifest.source_versions },
    executable_policy: structuredClone(manifest.executable_policy),
    profiles: {
      family: sortedProfiles(manifest.profiles.family.map(withoutHash)),
      artifact: sortedProfiles(manifest.profiles.artifact.map(withoutHash)),
      stage: sortedProfiles(manifest.profiles.stage.map(withoutHash)),
      pack: sortedProfiles(manifest.profiles.pack.map(withoutHash)),
      pricing: sortedProfiles(manifest.profiles.pricing.map(withoutHash)),
      send: sortedProfiles(manifest.profiles.send.map(withoutHash)),
    },
    variants: manifest.variants.map((variant) => {
      const { contract_hash: _contractHash, ...raw } = variant;
      return raw;
    }).sort((a, b) => codePointCompare(a.variant_id, b.variant_id)),
  };
}

export async function hashSesWorkflowContractSemanticContent(
  manifest: SesWorkflowContractManifest,
): Promise<SesSha256> {
  return await sesSha256(
    rawManifestFromExport(manifest),
    SES_WORKFLOW_CONTRACT_HASH_DOMAIN,
  );
}

/** Stable, deterministically sorted runtime manifest for adapters and drift CI. */
export async function exportSesContractSnapshot(): Promise<
  SesWorkflowContractManifest
> {
  const raw = buildRawManifest(await sesWorkflowExecutableSourceClosure());
  const contractHash = await sesSha256(
    raw,
    SES_WORKFLOW_CONTRACT_HASH_DOMAIN,
  );
  const decorate = <T extends SesWorkflowProfileBase>(
    profile: RawProfile<T>,
  ): T => ({ ...profile, contract_hash: contractHash } as T);
  return {
    ...raw,
    profiles: {
      family: raw.profiles.family.map(decorate),
      artifact: raw.profiles.artifact.map(decorate),
      stage: raw.profiles.stage.map(decorate),
      pack: raw.profiles.pack.map(decorate),
      pricing: raw.profiles.pricing.map(decorate),
      send: raw.profiles.send.map(decorate),
    },
    variants: raw.variants.map((variant) => ({
      ...variant,
      contract_hash: contractHash,
    })),
    canonical_contract_hash: contractHash,
  };
}

export interface SesWorkflowContractValidationError {
  code:
    | "canonical_contract_hash_mismatch"
    | "canonical_contract_lock_mismatch"
    | "duplicate_profile_id"
    | "duplicate_variant_id"
    | "family_set_incomplete"
    | "variant_set_incomplete"
    | "profile_missing"
    | "profile_hash_divergent"
    | "profile_internal_invalid"
    | "variant_profile_invalid"
    | "sealed_profile_incomplete"
    | "unsealed_variant_invalid"
    | "runtime_registry_mismatch"
    | "assessment_artifact_contract_invalid"
    | "swms_contract_invalid"
    | "pricing_contract_invalid"
    | "live_effects_enabled";
  detail: string;
  variant_id?: string;
  profile_id?: string;
}

export interface SesWorkflowContractValidationResult {
  valid: boolean;
  errors: SesWorkflowContractValidationError[];
}

function equalStringSet(left: readonly string[], right: readonly string[]) {
  return canonicalSesJson(sortedStrings(left)) ===
    canonicalSesJson(sortedStrings(right));
}

export async function validateSesWorkflowContractManifest(
  manifest: SesWorkflowContractManifest,
): Promise<SesWorkflowContractValidationResult> {
  const errors: SesWorkflowContractValidationError[] = [];
  const expected = buildRawManifest(await sesWorkflowExecutableSourceClosure());
  const recomputedHash = await hashSesWorkflowContractSemanticContent(manifest);
  if (recomputedHash !== manifest.canonical_contract_hash) {
    errors.push({
      code: "canonical_contract_hash_mismatch",
      detail:
        `manifest declares ${manifest.canonical_contract_hash} but recomputes ${recomputedHash}`,
    });
  }
  if (
    manifest.canonical_contract_hash !== SES_WORKFLOW_CONTRACT_CANONICAL_HASH
  ) {
    errors.push({
      code: "canonical_contract_lock_mismatch",
      detail:
        `manifest hash ${manifest.canonical_contract_hash} differs from pinned ${SES_WORKFLOW_CONTRACT_CANONICAL_HASH}`,
    });
  }
  if (
    canonicalSesJson(rawManifestFromExport(manifest)) !==
      canonicalSesJson(expected)
  ) {
    errors.push({
      code: "runtime_registry_mismatch",
      detail:
        "manifest semantic content does not match the current executable profile owners",
    });
  }

  const allProfiles = [
    ...manifest.profiles.family,
    ...manifest.profiles.artifact,
    ...manifest.profiles.stage,
    ...manifest.profiles.pack,
    ...manifest.profiles.pricing,
    ...manifest.profiles.send,
  ];
  const profileIds = new Set<string>();
  for (const profile of allProfiles) {
    if (profileIds.has(profile.profile_id)) {
      errors.push({
        code: "duplicate_profile_id",
        profile_id: profile.profile_id,
        detail: `profile id ${profile.profile_id} appears more than once`,
      });
    }
    profileIds.add(profile.profile_id);
    if (profile.contract_hash !== manifest.canonical_contract_hash) {
      errors.push({
        code: "profile_hash_divergent",
        profile_id: profile.profile_id,
        detail:
          `profile ${profile.profile_id} does not share the canonical hash`,
      });
    }
    if (
      profile.source_rule_ids.length === 0 ||
      (profile.seal_state === "sealed" &&
        profile.unsealed_reason_code !== null) ||
      (profile.seal_state === "unsealed" && !profile.unsealed_reason_code)
    ) {
      errors.push({
        code: "profile_internal_invalid",
        profile_id: profile.profile_id,
        detail:
          `profile ${profile.profile_id} has inconsistent seal metadata or no source rules`,
      });
    }
  }

  if (
    !equalStringSet(
      manifest.profiles.family.map((profile) => profile.family_id),
      SES_WORKFLOW_PUBLIC_FAMILIES,
    )
  ) {
    errors.push({
      code: "family_set_incomplete",
      detail: "registry does not expose exactly the six public SES families",
    });
  }
  if (
    !equalStringSet(
      manifest.variants.map((variant) => variant.variant_id),
      expected.variants.map((variant) => variant.variant_id),
    )
  ) {
    errors.push({
      code: "variant_set_incomplete",
      detail:
        "registry does not expose exactly the effective variants admitted by the family matrix",
    });
  }

  const profiles = new Map(
    allProfiles.map((profile) => [profile.profile_id, profile]),
  );
  const variantIds = new Set<string>();
  for (const variant of manifest.variants) {
    if (variantIds.has(variant.variant_id)) {
      errors.push({
        code: "duplicate_variant_id",
        variant_id: variant.variant_id,
        detail: `variant id ${variant.variant_id} appears more than once`,
      });
    }
    variantIds.add(variant.variant_id);
    const requiredProfileIds = [
      variant.family_profile_id,
      variant.artifact_profile_id,
      variant.stage_profile_id,
      variant.pack_profile_id,
      variant.pricing_profile_id,
      variant.expected_send_profile_id,
    ];
    const resolved = requiredProfileIds.map((profileId) =>
      profiles.get(profileId)
    );
    for (let index = 0; index < resolved.length; index++) {
      if (!resolved[index]) {
        errors.push({
          code: "profile_missing",
          variant_id: variant.variant_id,
          profile_id: requiredProfileIds[index],
          detail: `variant ${variant.variant_id} references missing profile ${
            requiredProfileIds[index]
          }`,
        });
      }
    }
    if (variant.contract_hash !== manifest.canonical_contract_hash) {
      errors.push({
        code: "profile_hash_divergent",
        variant_id: variant.variant_id,
        detail:
          `variant ${variant.variant_id} does not share the canonical hash`,
      });
    }
    const familyProfile = manifest.profiles.family.find((profile) =>
      profile.profile_id === variant.family_profile_id
    );
    const artifactProfile = manifest.profiles.artifact.find((profile) =>
      profile.profile_id === variant.artifact_profile_id
    );
    const stageProfile = manifest.profiles.stage.find((profile) =>
      profile.profile_id === variant.stage_profile_id
    );
    const packProfile = manifest.profiles.pack.find((profile) =>
      profile.profile_id === variant.pack_profile_id
    );
    const pricingProfile = manifest.profiles.pricing.find((profile) =>
      profile.profile_id === variant.pricing_profile_id
    );
    const sendProfile = manifest.profiles.send.find((profile) =>
      profile.profile_id === variant.expected_send_profile_id
    );
    if (
      familyProfile && familyProfile.family_id !== variant.family_id ||
      artifactProfile &&
        packProfile?.artifact_profile_id !== artifactProfile.profile_id ||
      stageProfile &&
        stageProfile.stage_engine_version !== SES_STAGE_ENGINE_V2_VERSION ||
      packProfile &&
        (packProfile.assembler_version !== SES_ASSEMBLER_VERSION ||
          packProfile.docket_envelope_version !== SES_DOCKET_ENVELOPE_VERSION ||
          packProfile.manifest_version !== SES_MANIFEST_V2_VERSION ||
          packProfile.review_spec_version !== SES_DOCKET_REVIEW_SPEC_VERSION ||
          !packProfile.prepare_only || !packProfile.detect_before_mint) ||
      pricingProfile &&
        (pricingProfile.profile_id !==
            `pricing.${pricingProfile.invoice_basis}.v1` ||
          pricingProfile.family_matrix_version !== SES_FAMILY_MATRIX_VERSION ||
          pricingProfile.pricing_rule_version !==
            SES_WORKFLOW_PRICING_RULE_VERSION ||
          Object.keys(pricingProfile.executable_semantics).length === 0 ||
          pricingProfile.unknown_builder_default) ||
      variant.release_contract_version !==
        SES_WORKFLOW_RELEASE_CONTRACT_VERSION ||
      variant.release_prerequisites.release_contract_enabled ||
      variant.release_prerequisites.wiki_backend_hash_agreed ||
      variant.release_prerequisites.atomic_release_lease_satisfied ||
      variant.live_release_enabled
    ) {
      errors.push({
        code: "variant_profile_invalid",
        variant_id: variant.variant_id,
        detail:
          `variant ${variant.variant_id} has an internally inconsistent family, stage, pack, pricing or release profile`,
      });
    }
    if (
      artifactProfile &&
      (artifactProfile.hard_required_artifacts.some((role) =>
        !artifactProfile.included_artifacts.includes(role)
      ) || artifactProfile.forbidden_artifacts.some((role) =>
        artifactProfile.included_artifacts.includes(role)
      ))
    ) {
      errors.push({
        code: "profile_internal_invalid",
        profile_id: artifactProfile.profile_id,
        variant_id: variant.variant_id,
        detail:
          `artifact profile ${artifactProfile.profile_id} has contradictory included, required or forbidden roles`,
      });
    }
    if (
      sendProfile &&
      (sendProfile.live_effects_enabled ||
        sendProfile.atomic_release_gate !== "required_before_live_release" ||
        sendProfile.send_rule_version !== SES_WORKFLOW_SEND_RULE_VERSION ||
        Object.keys(sendProfile.executable_semantics).length === 0 ||
        (sendProfile.seal_state === "sealed" &&
          (sendProfile.executable_send_recipe_id !== sendProfile.profile_id ||
            sendProfile.route_order.length === 0 ||
            sendProfile.unsealed_reason_code !== null)) ||
        (sendProfile.seal_state === "unsealed" &&
          (sendProfile.executable_send_recipe_id !== null ||
            !sendProfile.unsealed_reason_code)))
    ) {
      errors.push({
        code: "profile_internal_invalid",
        profile_id: sendProfile.profile_id,
        variant_id: variant.variant_id,
        detail: `send profile ${sendProfile.profile_id} is not internally safe`,
      });
    }
    const backendProfilesSealed = resolved.every((profile) =>
      profile?.seal_state === "sealed"
    );
    if (
      variant.backend_policy_seal_state !==
        (backendProfilesSealed ? "sealed" : "unsealed")
    ) {
      errors.push({
        code: "variant_profile_invalid",
        variant_id: variant.variant_id,
        detail:
          `variant ${variant.variant_id} misstates its backend policy seal`,
      });
    }
    if (variant.seal_state === "sealed") {
      if (
        variant.send_recipe_id !== sendProfile?.executable_send_recipe_id ||
        variant.send_recipe_id !== variant.expected_send_profile_id ||
        !backendProfilesSealed ||
        !variant.release_prerequisites.release_contract_enabled ||
        !variant.release_prerequisites.wiki_backend_hash_agreed ||
        !variant.release_prerequisites.atomic_release_lease_satisfied
      ) {
        errors.push({
          code: "sealed_profile_incomplete",
          variant_id: variant.variant_id,
          detail:
            `sealed variant ${variant.variant_id} lacks a sealed executable profile`,
        });
      }
    } else if (
      !variant.unsealed_reason_code || variant.live_release_enabled ||
      variant.send_recipe_id !== null
    ) {
      errors.push({
        code: "unsealed_variant_invalid",
        variant_id: variant.variant_id,
        detail:
          `unsealed variant ${variant.variant_id} must carry a reason and no executable send recipe`,
      });
    }
  }

  const assessment = manifest.profiles.artifact.find((profile) =>
    profile.profile_id === "artifacts.assessment.v1"
  );
  if (
    !assessment ||
    !equalStringSet(assessment.hard_required_artifacts, [
      "assessment_report",
      "photos",
      "quote",
      "invoice",
    ]) ||
    assessment.included_artifacts.includes("physical_report") ||
    !assessment.forbidden_artifacts.includes("physical_report")
  ) {
    errors.push({
      code: "assessment_artifact_contract_invalid",
      detail:
        "assessment must require assessment_report + photos + quote + invoice and forbid a physical report pointer",
    });
  }

  for (const profile of manifest.profiles.artifact) {
    const reportFamily = profile.profile_id.includes("roof") ||
      profile.profile_id.includes("assessment");
    const expectedRequirement = reportFamily
      ? "include_not_required_until_accuracy_gate"
      : "hard_required";
    if (
      profile.swms_generation !== "generated_scope_correct" ||
      profile.swms_requirement !== expectedRequirement ||
      !profile.included_artifacts.includes("scope_correct_swms") ||
      (!reportFamily &&
        !profile.hard_required_artifacts.includes("scope_correct_swms"))
    ) {
      errors.push({
        code: "swms_contract_invalid",
        profile_id: profile.profile_id,
        detail: `profile ${profile.profile_id} has an invalid SWMS contract`,
      });
    }
  }
  for (const profile of manifest.profiles.pricing) {
    if (profile.unknown_builder_default) {
      errors.push({
        code: "pricing_contract_invalid",
        profile_id: profile.profile_id,
        detail: "pricing profiles may not carry an unknown-builder default",
      });
    }
  }
  for (const profile of manifest.profiles.send) {
    if (profile.live_effects_enabled) {
      errors.push({
        code: "live_effects_enabled",
        profile_id: profile.profile_id,
        detail: "convergence slice 1 cannot enable live effects",
      });
    }
  }
  return { valid: errors.length === 0, errors };
}

export type SesWorkflowReleasePreparationRefusalCode =
  | "unsupported_family_variant"
  | "deliverable_not_active"
  | "family_contract_incomplete"
  | "family_contract_divergent"
  | "family_contract_invalid"
  | "family_contract_unsealed";

export interface SesWorkflowReleasePreparationRefusal {
  ok: false;
  state: "refused";
  phase: "before_approval_or_effects";
  code: SesWorkflowReleasePreparationRefusalCode;
  reason: string;
  variant_id: string | null;
  profile_id: string | null;
  approval_allowed: false;
  external_effects_allowed: false;
}

export interface SesWorkflowReleaseContractPrepared {
  ok: true;
  state: "contract_prepared";
  phase: "before_approval_or_effects";
  variant: SesWorkflowEffectiveVariant;
  profiles: {
    family: SesWorkflowFamilyProfile;
    artifact: SesWorkflowArtifactProfile;
    stage: SesWorkflowStageProfile;
    pack: SesWorkflowPackProfile;
    pricing: SesWorkflowPricingProfile;
    send: SesWorkflowSendProfile;
  };
  canonical_contract_hash: SesSha256;
  approval_allowed: false;
  external_effects_allowed: false;
}

export type SesWorkflowReleasePreparationResult =
  | SesWorkflowReleasePreparationRefusal
  | SesWorkflowReleaseContractPrepared;

export interface SesWorkflowReleasePreparationInput {
  builder_key: SesBuilderKey;
  runtime_family_id: SesFamilyId;
  routing_rule?: SesFamilyMatrixRow["routing_rule"];
  strata?: boolean;
  own_template_requested?: boolean;
  site_suburb?: unknown;
  deliverable_active?: boolean;
}

export interface SesWorkflowBackendPolicyPrepared {
  ok: true;
  state: "backend_policy_prepared";
  phase: "before_approval_or_effects";
  variant: SesWorkflowEffectiveVariant;
  profiles: SesWorkflowReleaseContractPrepared["profiles"];
  canonical_contract_hash: SesSha256;
  approval_allowed: false;
  external_effects_allowed: false;
}

export type SesWorkflowBackendPolicyPreparationResult =
  | SesWorkflowReleasePreparationRefusal
  | SesWorkflowBackendPolicyPrepared;

function refusal(
  code: SesWorkflowReleasePreparationRefusalCode,
  reason: string,
  variantId: string | null = null,
  profileId: string | null = null,
): SesWorkflowReleasePreparationRefusal {
  return {
    ok: false,
    state: "refused",
    phase: "before_approval_or_effects",
    code,
    reason,
    variant_id: variantId,
    profile_id: profileId,
    approval_allowed: false,
    external_effects_allowed: false,
  };
}

/** Resolve and validate the backend-owned profile chain without enabling it. */
export async function prepareSesWorkflowBackendPolicyContract(
  input: SesWorkflowReleasePreparationInput,
  manifest?: SesWorkflowContractManifest,
): Promise<SesWorkflowBackendPolicyPreparationResult> {
  manifest = manifest ?? await exportSesContractSnapshot();
  let variant: SesWorkflowEffectiveVariant | undefined;
  if (input.routing_rule) {
    variant = manifest.variants.find((candidate) =>
      candidate.runtime_family_id === input.runtime_family_id &&
      candidate.builder_key === input.builder_key &&
      candidate.routing_rule === input.routing_rule
    );
  } else {
    const matrix = resolveSesFamilyMatrixRow({
      builder_key: input.builder_key,
      family: input.runtime_family_id,
      strata: input.strata,
      own_template_requested: input.own_template_requested,
      site_suburb: input.site_suburb,
    });
    if (!matrix.ok) {
      return refusal("unsupported_family_variant", matrix.failure.reason);
    }
    variant = manifest.variants.find((candidate) =>
      candidate.runtime_family_id === matrix.row.family &&
      candidate.builder_key === matrix.row.builder_key &&
      candidate.routing_rule === matrix.row.routing_rule
    );
  }
  if (!variant) {
    return refusal(
      "unsupported_family_variant",
      "The resolved matrix row has no workflow-registry variant.",
    );
  }
  const references = [
    ["family", variant.family_profile_id, manifest.profiles.family] as const,
    [
      "artifact",
      variant.artifact_profile_id,
      manifest.profiles.artifact,
    ] as const,
    ["stage", variant.stage_profile_id, manifest.profiles.stage] as const,
    ["pack", variant.pack_profile_id, manifest.profiles.pack] as const,
    ["pricing", variant.pricing_profile_id, manifest.profiles.pricing] as const,
    [
      "send",
      variant.expected_send_profile_id,
      manifest.profiles.send,
    ] as const,
  ];
  const selected: Record<string, SesWorkflowProfileBase> = {};
  for (const [kind, profileId, collection] of references) {
    const profile = (collection as readonly SesWorkflowProfileBase[]).find(
      (candidate) => candidate.profile_id === profileId,
    );
    if (!profile) {
      return refusal(
        "family_contract_incomplete",
        `${kind} profile ${profileId} is missing.`,
        variant.variant_id,
        profileId,
      );
    }
    selected[kind] = profile;
  }
  const selectedFamily = selected.family as SesWorkflowFamilyProfile;
  if (
    selectedFamily.active_deliverable_required &&
    input.deliverable_active !== true
  ) {
    return refusal(
      "deliverable_not_active",
      `${variant.family_id} has no active SES reporting deliverable.`,
      variant.variant_id,
      selectedFamily.profile_id,
    );
  }

  const recomputedHash = await hashSesWorkflowContractSemanticContent(manifest);
  if (
    recomputedHash !== manifest.canonical_contract_hash ||
    manifest.canonical_contract_hash !== SES_WORKFLOW_CONTRACT_CANONICAL_HASH ||
    variant.contract_hash !== manifest.canonical_contract_hash ||
    Object.values(selected).some((profile) =>
      profile.contract_hash !== manifest.canonical_contract_hash
    )
  ) {
    return refusal(
      "family_contract_divergent",
      "The effective profile chain does not share the pinned canonical contract hash.",
      variant.variant_id,
    );
  }

  const validation = await validateSesWorkflowContractManifest(manifest);
  if (!validation.valid) {
    return refusal(
      "family_contract_invalid",
      validation.errors[0]?.detail || "The workflow contract is invalid.",
      variant.variant_id,
      validation.errors[0]?.profile_id || null,
    );
  }
  if (
    variant.backend_policy_seal_state !== "sealed" ||
    Object.values(selected).some((profile) => profile.seal_state !== "sealed")
  ) {
    return refusal(
      "family_contract_unsealed",
      variant.unsealed_reason_code ||
        "The effective workflow profile chain is not sealed.",
      variant.variant_id,
      variant.expected_send_profile_id,
    );
  }

  return {
    ok: true,
    state: "backend_policy_prepared",
    phase: "before_approval_or_effects",
    variant,
    profiles:
      selected as unknown as SesWorkflowReleaseContractPrepared["profiles"],
    canonical_contract_hash: manifest.canonical_contract_hash,
    approval_allowed: false,
    external_effects_allowed: false,
  };
}

/**
 * AC19 pure release preflight. The backend policy chain may be coherent while
 * the effective release remains unsealed: this slice deliberately leaves the
 * wiki hash, settled release contract and database-atomic lease prerequisites
 * false, so it cannot enable approval or an external effect.
 */
export async function prepareSesWorkflowReleaseContract(
  input: SesWorkflowReleasePreparationInput,
  manifest?: SesWorkflowContractManifest,
): Promise<SesWorkflowReleasePreparationResult> {
  const prepared = await prepareSesWorkflowBackendPolicyContract(
    input,
    manifest,
  );
  if (!prepared.ok) return prepared;
  if (
    prepared.variant.seal_state !== "sealed" ||
    !prepared.variant.release_prerequisites.release_contract_enabled ||
    !prepared.variant.release_prerequisites.wiki_backend_hash_agreed ||
    !prepared.variant.release_prerequisites.atomic_release_lease_satisfied
  ) {
    return refusal(
      "family_contract_unsealed",
      prepared.variant.unsealed_reason_code ||
        "The effective release contract prerequisites are not sealed.",
      prepared.variant.variant_id,
      prepared.variant.expected_send_profile_id,
    );
  }
  return {
    ...prepared,
    state: "contract_prepared",
  };
}
