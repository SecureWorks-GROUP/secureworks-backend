import {
  artifactFromBytes,
  artifactFromText,
  canonicalSesJson,
  SES_ASSEMBLER_VERSION,
  SES_DOCKET_ENVELOPE_VERSION,
  SES_INPUT_CONTRACT_VERSION,
  SES_MANIFEST_V2_VERSION,
  type SesArtifact,
  type SesAssemblerInputV1,
  type SesBlocker,
  type SesDocketEnvelopeV3,
  type SesManifestV2,
  type SesNotApplicableState,
  type SesObligationState,
  type SesPhysicalReportProof,
  type SesPortalCapture,
  type SesPreparedRevision,
  type SesPrepareRequest,
  type SesReadyState,
  type SesSha256,
  sesSha256,
  sesSha256Bytes,
  stableUuidFromSha256,
} from "./ses_docket_envelope.ts";
import {
  resolveSesFamilyMatrixRow,
  SES_ASSESSMENT_RECIPE_VERSION,
  SES_FAMILY_MATRIX_VERSION,
  SES_PHYSICAL_FAMILY_RECIPE_VERSION,
  type SesFamilyId,
  type SesFamilyMatrixRow,
} from "./ses_family_matrix.ts";
import {
  ajsPackCc,
  isAjsBuilderKey,
  mlbPhysicalRouteRecipients,
} from "./ses_release_route_shape.ts";
import {
  evaluateSesPhotoMailVolume,
  resolveSesMailTransportForPrepare,
  sesPhotoMailVolumeBlocker,
} from "./ses_photo_mail_volume_guard.ts";
import {
  isMlbPhysicalReleaseShape,
  mlbOrdinaryMailSubject,
  mlbPhysicalUsesOrdinaryMailSendFallback,
} from "./ses_mlb_thread_reply.ts";
import { AJS_EXISTING_FENCE_STAR_PICKET_RATE_EX_GST } from "./makesafe_existing_fence_pickets.ts";
import {
  MAKESAFE_REPORT_CONTRACT_VERSION,
  makesafeReportFileName,
} from "./makesafe_report_render.ts";
import { roofReportPrice } from "./roof_report_template.ts";
import {
  buildSesSwmsGenerationPlan,
  type SesSwmsGenerationPlan,
} from "./ses_swms_template.ts";
import {
  carriedMaterialsChargeDecision,
  decideStandardLabourMaterialsCharge,
  MATERIALS_CHARGE_DECISION_FACT,
  MATERIALS_CHARGE_FIGURE_UNSUPPORTED,
  materialsChargeDecisionMarker,
  recordedMaterialsUsed,
  type SesMaterialsChargeStandingDecision,
} from "./ses_materials_charge_guard.ts";
import type {
  SesInvoicedMaterialsEvidence,
  SesInvoicedMaterialsReading,
  SesReleasedCycleEvidence,
  SesReleasedCycleReading,
} from "./ses_invoiced_materials_evidence.ts";

export const SES_FIVE_MINUTES_MS = 300_000;
export const SES_DOCKET_REVIEW_SPEC_VERSION = "ses-docket-review/v2";
export const SES_DOCKET_OUTPUT_HASH_VERSION = "v2";
export const SES_DOCKET_OUTPUT_HASH_DOMAIN =
  `SecureWorks:ses-docket-output:${SES_DOCKET_OUTPUT_HASH_VERSION}\n`;
export const SES_DOCKET_REVISION_IDENTITY_DOMAIN =
  "SecureWorks:ses-docket-revision-id:v1\n";
export { SES_ASSESSMENT_RECIPE_VERSION, SES_PHYSICAL_FAMILY_RECIPE_VERSION };

export function sesDocketPersistedIdempotencyKey(
  idempotencyKey: string,
  outputHashVersion: string = SES_DOCKET_OUTPUT_HASH_VERSION,
): string {
  return outputHashVersion === "v1"
    ? idempotencyKey
    : `${idempotencyKey}#ses-docket-output:${outputHashVersion}`;
}

export const SES_DOCKET_LEGACY_OUTPUT_HASH_VERSION = "v1";

export async function sesDocketRevisionIdentity(args: {
  assembler_version: string;
  family_matrix_version: string;
  idempotency_key: string;
  input_content_hash: SesSha256;
  output_hash_version?: string;
}): Promise<{ idempotency_key: string; revision_id: string }> {
  const idempotencyKey = sesDocketPersistedIdempotencyKey(
    args.idempotency_key,
    args.output_hash_version ?? SES_DOCKET_OUTPUT_HASH_VERSION,
  );
  const identityHash = await sesSha256(
    {
      assembler_version: args.assembler_version,
      family_matrix_version: args.family_matrix_version,
      idempotency_key: idempotencyKey,
      input_content_hash: args.input_content_hash,
    },
    SES_DOCKET_REVISION_IDENTITY_DOMAIN,
  );
  return {
    idempotency_key: idempotencyKey,
    revision_id: stableUuidFromSha256(identityHash),
  };
}

const MANIFEST_ITEMS = [
  "source_work_order_retrieval",
  "source_work_order_identity",
  "source_work_order_attachment",
  "instruction_deliverables",
  "lineage_review",
  "case_story_recovery",
  "exception_disposition",
  "hrcw_assessment",
  "swms_requirement",
  "swms_artifact",
  "builder_routing",
  "supporting_report_pdf",
  "supporting_invoice_pdf",
  "supporting_portal_links",
  "roof_report_link",
  "roof_report_capture",
  "assessment_report_link",
  "assessment_report_capture",
  "assessment_photos_link",
  "assessment_photos_capture",
  "assessment_scope_link",
  "assessment_scope_capture",
  "physical_reporting_evidence",
  "draft_builder_report_email",
  "draft_photo_evidence_email",
  "draft_invoice_bundle_email",
  "email_drafts_presented",
] as const;

type ManifestItem = (typeof MANIFEST_ITEMS)[number];

export interface SesRenderResult {
  file_name: string;
  media_type: "application/pdf";
  bytes: Uint8Array;
  render_hash?: string;
  provenance?: Record<string, unknown>;
}

export interface SesSourceArtifact {
  source_pointer: string;
  file_name: string;
  media_type: string;
  bytes: Uint8Array;
}

export interface SesPhotoArtifact {
  photo_id: string;
  source_pointer: string;
  file_name: string;
  media_type: "image/jpeg" | "image/png";
  bytes: Uint8Array;
}

export interface SesPhotoProof {
  photo_id: string;
  source_pointer: string;
  file_name: string;
  media_type: "image/jpeg" | "image/png";
  content_hash: SesSha256;
  size_bytes: number;
}

async function rawArtifactSha256(bytes: Uint8Array): Promise<SesSha256> {
  const safeBytes = new Uint8Array(bytes.byteLength);
  safeBytes.set(bytes);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", safeBytes.buffer),
  );
  return `sha256:${
    Array.from(digest).map((byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    )
  }`;
}

function validPhysicalReportProof(
  proof: SesPhysicalReportProof | null | undefined,
): proof is SesPhysicalReportProof {
  if (!proof) return false;
  if (
    proof.source_kind !== "durable_curated_revision" &&
    proof.source_kind !== "previously_committed_pdf"
  ) return false;
  if (
    !text(proof.source_identity) ||
    !text(proof.source_document_id) ||
    proof.source_identity === proof.source_document_id ||
    !/^sha256:[0-9a-f]{64}$/.test(proof.expected_raw_sha256) ||
    (proof.report_input_hash !== undefined &&
      !/^sha256:[0-9a-f]{64}$/.test(proof.report_input_hash))
  ) return false;
  if (
    !text(proof.source_revision_id) || !text(proof.source_artifact_id) ||
    !/^sha256:[0-9a-f]{64}$/.test(proof.source_artifact_content_hash)
  ) return false;
  return true;
}

function samePhysicalReportProof(
  left: SesPhysicalReportProof | null | undefined,
  right: SesPhysicalReportProof | null | undefined,
): boolean {
  return validPhysicalReportProof(left) && validPhysicalReportProof(right) &&
    canonicalSesJson(left) === canonicalSesJson(right);
}

export interface SesPortalCaptureRequest {
  job_id: string;
  docket_id: string;
  builder_reference: string;
  role: "roof_report" | "assessment" | "photos" | "scope";
  url: string;
  idempotency_key: string;
}

export interface SesDocketRevisionIdentity {
  idempotency_key: string;
  revision_id: string;
}

export interface SesPersistPayload {
  revision: Omit<SesPreparedRevision, "timing" | "persisted" | "artifacts">;
  artifacts: SesArtifact[];
  idempotency_key: string;
  legacy_identity?: SesDocketRevisionIdentity;
  assembler_version: "ses-pack-assembler/v1";
  family_matrix_version: string;
  accepted_at: string;
  stage_durations_ms: Record<string, number>;
}

export interface SesPrepareDependencies {
  resolveInput: (
    selection: Exclude<SesPrepareRequest["selection"], { mode: "board_batch" }>,
  ) => Promise<SesAssemblerInputV1>;
  listBoardJobs?: (
    limit: number,
  ) => Promise<Array<{ mode: "job_id"; job_id: string }>>;
  resolveSourceArtifacts?: (
    input: SesAssemblerInputV1,
  ) => Promise<SesSourceArtifact[]>;
  resolvePhotoArtifacts?: (
    input: SesAssemblerInputV1,
  ) => Promise<SesPhotoArtifact[]>;
  resolvePhotoProofs?: (
    input: SesAssemblerInputV1,
  ) => Promise<SesPhotoProof[]>;
  resolvePhysicalReportProof?: (
    input: SesAssemblerInputV1,
  ) => Promise<SesPhysicalReportProof | null>;
  resolveBundledPhysicalReportProof?: (
    input: SesAssemblerInputV1,
  ) => Promise<SesPhysicalReportProof | null>;
  renderBundledPhysicalReport?: (
    input: SesAssemblerInputV1,
    proof: SesPhysicalReportProof,
  ) => Promise<SesRenderResult | null>;
  capturePortal?: (
    request: SesPortalCaptureRequest,
  ) => Promise<SesPortalCapture>;
  renderPhysicalReport?: (
    input: SesAssemblerInputV1,
    photos?: SesPhotoArtifact[],
    proof?: SesPhysicalReportProof,
  ) => Promise<SesRenderResult>;
  renderOwnRoofReport?: (
    input: SesAssemblerInputV1,
  ) => Promise<SesRenderResult>;
  resolveBundledReportArtifact?: (
    input: SesAssemblerInputV1,
  ) => Promise<SesRenderResult | null>;
  resolveBundledPhotoArtifacts?: (
    input: SesAssemblerInputV1,
  ) => Promise<SesPhotoArtifact[]>;
  resolveSwmsArtifact?: (
    input: SesAssemblerInputV1,
  ) => Promise<SesRenderResult | null>;
  renderSwmsArtifact?: (
    plan: SesSwmsGenerationPlan,
  ) => Promise<SesRenderResult | null>;
  findCurrentRevision?: (
    jobId: string,
    inputContentHash: SesSha256,
  ) => Promise<SesPreparedRevision | null>;
  /**
   * The `materials_charge` provenance already committed on this card's most
   * recent docket revision for this attendance cycle, so a prepare that omits
   * the body figure inherits the Captain's answer instead of re-asking.
   */
  resolvePriorMaterialsCharge?: (args: {
    job_id: string;
    attendance_cycle_id: string;
  }) => Promise<unknown>;
  /**
   * What the card's already-settled state says about its materials: whether the
   * CURRENT attendance cycle has shipped and been billed, and what its issued
   * invoice priced. Both are read fresh from the local `ses_release_route_proofs`
   * and `xero_invoices` mirrors. Read-only and money-safe: they inspect records
   * that already exist and write nothing, so neither the sealed SES money fence
   * nor any Xero record is touched.
   */
  resolveMaterialsAnswerEvidence?: (args: {
    job_id: string;
    attendance_cycle_id: string | null;
  }) => Promise<{
    released: SesReleasedCycleReading;
    invoiced: SesInvoicedMaterialsReading;
  }>;
  persist?: (payload: SesPersistPayload) => Promise<{ committed_at: string }>;
  now?: () => Date;
}

export interface SesPrepareResponse {
  action: "prepare_ses_docket_revision";
  assembler_version: "ses-pack-assembler/v1";
  dry_run: boolean;
  results: SesPreparedRevision[];
  timing_summary: {
    count: number;
    max_ms: number;
    p95_ms: number;
    all_within_five_minutes: boolean;
  };
}

function blocked(
  reason_code: string,
  reason: string,
  recovery_action: string,
  searches_attempted: string[] = ["canonical-input-envelope"],
  rejected_candidates: string[] = [],
  facts?: Record<string, unknown>,
): SesBlocker {
  return {
    state: "blocked",
    reason,
    reason_code,
    searches_attempted,
    rejected_candidates,
    recovery_action,
    ...(facts ? { facts } : {}),
  };
}

function ready(evidence: string): SesReadyState {
  return { state: "ready", evidence };
}

function notApplicable(rule: string): SesNotApplicableState {
  return { state: "not_applicable", rule };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function reviewTradeReport(
  input: SesAssemblerInputV1,
): Record<string, unknown> | null {
  if (!input.cycle_facts.trade_report) return null;

  // This is reviewer evidence, not builder-facing report copy. The served PDF
  // remains exclusively bound to the curated artifact recovery path below.
  const report = object(input.cycle_facts.trade_report);
  const checklist = object(report.checklist_json);
  return {
    source: {
      relation: "job_service_reports",
      id: text(report.id) || null,
      status: text(report.status) || null,
      submitted_at: text(report.submitted_at) || null,
      job_id: input.identity.job_id,
      attendance_cycle_id: input.attendance.current_attendance_cycle_id,
      cycle_number: input.attendance.cycle_number,
      selection: "current_attendance_cycle",
    },
    asserted_written_narrative: {
      scope: text(checklist.scope) || null,
      damage_description: text(checklist.damage_description) || null,
      findings: text(checklist.findings) || null,
      damage_cause: text(checklist.damage_cause) || null,
      works_completed: text(checklist.works_completed) || null,
      works: text(checklist.works) || null,
      work_done: text(checklist.work_done) || null,
      // Structured selections remain source evidence below. Only prose the
      // trade explicitly wrote may appear in the asserted narrative surface.
      materials: text(checklist.materials) || null,
      materials_used: text(checklist.materials_used) || null,
      notes: text(report.notes) || null,
    },
    raw_source_evidence: {
      checklist_json: report.checklist_json ?? {},
      notes: report.notes ?? null,
    },
  };
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveNumber(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && Number.isInteger(number) && number >= 0
    ? number
    : null;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.normalize("NFC")))].sort();
}

function inputBlockers(input: SesAssemblerInputV1): SesBlocker[] {
  const blockers: SesBlocker[] = [];
  if (input.classification.builder_key === "SYNTHETIC") {
    blockers.push(blocked(
      "synthetic_livefire_release_forbidden",
      "Synthetic live-fire dockets are evidence-only and can never be released, sent, signed off, or used to create an invoice.",
      "Retain the dry-run evidence and terminally account the synthetic fixture; there is no release recovery path.",
      ["synthetic-livefire-profile", "canonical-input-envelope"],
    ));
  }
  if (input.contract_version !== SES_INPUT_CONTRACT_VERSION) {
    blockers.push(
      blocked(
        "input_hash_conflict",
        `Unsupported assembler input contract ${input.contract_version}.`,
        `Supply ${SES_INPUT_CONTRACT_VERSION} from the canonical U1/U2 read model.`,
      ),
    );
  }
  const bundle = input.sibling_bundle_evidence;
  if (bundle && bundle.status !== "accepted") {
    const sibling = bundle.suspected_sibling_job_number || "(unknown sibling)";
    const invoice = bundle.suspected_invoice_number || "(unknown invoice)";
    const sharedFacts = {
      suspected_sibling_job_id: bundle.suspected_sibling_job_id,
      suspected_sibling_job_number: sibling,
      suspected_invoice_number: bundle.suspected_invoice_number,
      bundle_id: bundle.bundle_id,
      binding_revision_id: bundle.binding_revision_id,
      reverse_binding_revision_id: bundle.reverse_binding_revision_id,
      coverage_failures: bundle.coverage_failures,
    };
    if (bundle.status === "binding_missing") {
      blockers.push(blocked(
        "sibling_evidence_bundle_missing",
        `Card-local evidence is absent and suspected sibling ${sibling} (${invoice}) has no explicit bundle binding.`,
        `Create a durable, provenance-recorded binding in both directions between this card and ${sibling}; do not infer it from address or freeform notes.`,
        ["canonical-input-envelope", "sibling-bundle-binding-ledger"],
        [sibling],
        sharedFacts,
      ));
    } else if (bundle.status === "binding_not_bidirectional") {
      blockers.push(blocked(
        "sibling_evidence_bundle_not_bidirectional",
        `Sibling ${sibling} has only a one-way bundle reference, so its evidence cannot be borrowed.`,
        `Record the reverse binding under bundle ${bundle.bundle_id} with provenance, then re-run.`,
        ["canonical-input-envelope", "sibling-bundle-binding-ledger"],
        [sibling],
        sharedFacts,
      ));
    } else {
      blockers.push(blocked(
        "sibling_evidence_scope_not_covered",
        `The explicit bundle with ${sibling} does not positively prove this card's delivery and invoice scope.`,
        `Repair the exact ${invoice} line-item and delivery-artifact claim before sharing sibling evidence.`,
        [
          "canonical-input-envelope",
          "sibling-bundle-binding-ledger",
          "sibling-positive-scope-claim",
        ],
        [sibling, invoice],
        sharedFacts,
      ));
    }
  }
  if (!text(input.identity.source_instruction_id)) {
    blockers.push(
      blocked(
        "spine_missing_source",
        "Correlation spine has no source_instruction_id.",
        "Repair the U1 source accounting bind and re-run.",
      ),
    );
  }
  if (
    !text(input.identity.lineage_id) ||
    !text(input.identity.job_id) ||
    !text(input.identity.source_content_hash)
  ) {
    blockers.push(
      blocked(
        "spine_missing_lineage",
        "Correlation spine is missing lineage, job, or source content identity.",
        "Repair the U1 lineage/job authority bind and re-run.",
      ),
    );
  }
  const cycles = sortedUnique(input.attendance.attendance_cycle_ids || []);
  if (
    input.attendance.attribution !== "bound" ||
    !text(input.attendance.current_attendance_cycle_id) ||
    !cycles.includes(input.attendance.current_attendance_cycle_id)
  ) {
    blockers.push(
      blocked(
        "cycle_scope_ambiguous",
        "Current attendance cycle is not exactly bound inside the immutable cycle set.",
        "Bind the current U2/U3 attendance_cycle_id before assembling evidence.",
      ),
    );
  }
  if (
    input.classification.family_matrix_version !== SES_FAMILY_MATRIX_VERSION
  ) {
    blockers.push(
      blocked(
        "input_hash_conflict",
        `Input pins ${
          input.classification.family_matrix_version || "(blank)"
        } but assembler requires ${SES_FAMILY_MATRIX_VERSION}.`,
        "Refresh the U1/U2 assembler envelope against the current family matrix.",
      ),
    );
  }
  if (!text(input.source.builder_reference)) {
    blockers.push(
      blocked(
        "spine_missing_source",
        "Builder reference is absent from the canonical source instruction.",
        "Recover the WO/PO/external reference from the canonical source case.",
      ),
    );
  }
  if (input.classification.family === "unknown") {
    const card = text(input.identity.card_id) || text(input.identity.job_id);
    blockers.push(
      blocked(
        "family_unknown",
        `Card ${card || "(unknown)"} has no canonical family classification.`,
        "Recover the family classification from canonical source authority before preparing the docket.",
      ),
    );
  }
  if (input.classification.delivery_render_route === "unroutable") {
    blockers.push(
      blocked(
        "delivery_route_unroutable",
        input.classification.delivery_render_route_reason ||
          "The card has no sealed delivery/render route.",
        "Bind one source-backed portal or SecureWorks own-letterhead route for this builder-family relationship, then re-run.",
        [
          "canonical-input-envelope",
          ...input.classification.delivery_render_route_evidence,
        ],
        [],
        {
          builder_key: input.classification.builder_key,
          family: input.classification.family,
          delivery_render_route: input.classification.delivery_render_route,
          route_reason_code:
            input.classification.delivery_render_route_reason_code,
          route_evidence: input.classification.delivery_render_route_evidence,
        },
      ),
    );
  }
  if (!text(input.source.work_order_sender)) {
    blockers.push(
      blocked(
        "routing_evidence_missing",
        "The company routing table has no report recipient for this builder.",
        "Set the builder report recipient in makesafe_companies; do not substitute a guessed or unrelated address.",
      ),
    );
  }
  if (!input.source.attachment_pointers?.length) {
    blockers.push(
      blocked(
        "spine_missing_source",
        "The work order email has no work order attachment - ask the builder to send the work order.",
        "Recover the work order from the builder's source email, then prepare the card again.",
      ),
    );
  }
  if (!input.source.deliverables?.length) {
    blockers.push(
      blocked(
        "spine_missing_deliverables",
        "Source instruction has no typed deliverables.",
        "Complete deterministic instruction classification before pack preparation.",
      ),
    );
  }
  if (
    input.classification.family === "assessment_quote" &&
    input.classification.assessment_outbound_recipe_version !==
      SES_ASSESSMENT_RECIPE_VERSION
  ) {
    blockers.push(
      blocked(
        "input_hash_conflict",
        "The assessment card does not carry the sealed triad-and-invoice recipe.",
        "Refresh the assembler input from the current assessment family rule.",
      ),
    );
  }
  return blockers;
}

function swmsDecision(
  input: SesAssemblerInputV1,
  row: SesFamilyMatrixRow,
): {
  required: boolean;
  requirementEvidence: string;
  naRule: string | null;
} {
  if (row.report_only) {
    return {
      required: false,
      requirementEvidence:
        `rule:swms-not-required-under-named-builder-job-rule#${row.swms_waiver_rule}`,
      naRule: "report-only-has-no-physical-work",
    };
  }
  if (
    input.hrcw.hrcw ||
    input.hrcw.categories.length > 0 ||
    input.hrcw.source_hazard_terms.length > 0
  ) {
    return {
      required: true,
      requirementEvidence: "rule:hrcw-requires-swms",
      naRule: null,
    };
  }
  if (row.swms_policy === "always") {
    return {
      required: true,
      requirementEvidence: "rule:physical-work-requires-swms",
      naRule: null,
    };
  }
  if (row.swms_policy === "builder_waiver_unless_hrcw") {
    return {
      required: false,
      requirementEvidence:
        `rule:swms-not-required-under-named-builder-job-rule#${row.swms_waiver_rule}`,
      naRule: "swms-not-required-under-named-builder-job-rule",
    };
  }
  return {
    required: false,
    requirementEvidence:
      "rule:swms-not-required-under-named-builder-job-rule#western-explicit-hrcw-only",
    naRule: "swms-not-required-under-named-builder-job-rule",
  };
}

function lineItem(
  description: string,
  quantity: number,
  unitPriceExGst: number,
): Record<string, unknown> {
  return {
    description,
    quantity,
    unit_price_ex_gst: unitPriceExGst,
    amount_ex_gst: Math.round(quantity * unitPriceExGst * 100) / 100,
  };
}

/**
 * What the builder reads on the labour line of a real Xero DRAFT.
 * `prepare_ses_invoice_obligation` copies these lines verbatim, so the
 * description must name the family that was actually attended — a sealed
 * repair or restoration card is not a make-safe.
 */
function attendanceLineSubject(family: SesFamilyId): string {
  switch (family) {
    case "temporary_fencing":
      return "temporary fencing make-safe";
    case "repair":
      return "repair attendance";
    case "restoration":
      return "restoration attendance";
    default:
      return "make-safe attendance";
  }
}

/**
 * The card's recorded materials-used fact, in one place. The envelope surfaces
 * it only for the families the materials-charge guard governs, so the trade
 * report's own checklist stays the fallback.
 */
function recordedMaterialsFact(input: SesAssemblerInputV1): unknown {
  const facts = input.cycle_facts.hours_and_materials || {};
  if (Object.hasOwn(facts, "materials_used")) return facts.materials_used;
  return object(object(input.cycle_facts.trade_report).checklist_json)
    .materials_used;
}

/**
 * Whether the card carries typed material FACTS — the priced
 * description/quantity/unit-price lines the proposal bills directly.
 *
 * Read straight off the same `hours_and_materials.materials` array the pricing
 * loop iterates, so the pre-hash question ("could issued-invoice evidence
 * decide anything here?") and the pricing answer cannot drift apart.
 */
function typedMaterialFactsPresent(input: SesAssemblerInputV1): boolean {
  const facts = input.cycle_facts.hours_and_materials || {};
  return Array.isArray(facts.materials) && facts.materials.length > 0;
}

function localInvoiceProposal(
  input: SesAssemblerInputV1,
  row: SesFamilyMatrixRow,
  materialsChargeDecision: SesMaterialsChargeStandingDecision | null = null,
  invoicedMaterialsEvidence: SesInvoicedMaterialsEvidence | null = null,
  releasedCycleEvidence: SesReleasedCycleEvidence | null = null,
  materialsChargeSuppliedNow = false,
): {
  proposal: Record<string, unknown> | null;
  blocker: SesBlocker | null;
  /**
   * The materials decision REFUSED the figure it was given. A refused figure
   * was never an accepted decision, so the caller must not stamp it as the
   * card's durable materials-charge marker: inheriting it would let a figure
   * nobody accepted answer the next prepare — and, on a released cycle, bill
   * materials the builder has already paid for.
   */
  materials_charge_refused?: boolean;
} {
  const facts = input.cycle_facts.hours_and_materials || {};
  const ref = input.source.builder_reference;
  if (!text(ref)) {
    return {
      proposal: null,
      blocker: blocked(
        "invoice_reference_missing",
        "A local invoice proposal requires a non-empty builder WO/PO reference.",
        "Recover the canonical builder reference before assembling any invoice line.",
      ),
    };
  }
  // A materials-charge decision is never silently dropped. Only the
  // standard_labour_materials basis can host one; every other basis refuses
  // loudly rather than pricing as if the operator had said nothing.
  // Inheritance is already basis-gated, so only a body-supplied decision
  // reaches this.
  if (
    materialsChargeDecision &&
    row.invoice_basis !== "standard_labour_materials"
  ) {
    const charged = materialsChargeDecision.decision === "charge";
    return {
      proposal: null,
      materials_charge_refused: true,
      blocker: blocked(
        MATERIALS_CHARGE_FIGURE_UNSUPPORTED,
        `${
          charged
            ? `A materials charge of $${materialsChargeDecision.authorisation.amount_ex_gst} ex GST was authorised`
            : "A no-materials-charge decision was recorded"
        }, but this card prices on ${row.invoice_basis}, which has no operator materials charge line.`,
        "Drop the materials_charge body key and re-run. The materials-charge decision exists only for the standard_labour_materials basis (non-AJS physical, repair and restoration cards).",
        ["canonical-input-envelope", "sealed-family-matrix"],
        [],
        {
          invoice_basis: row.invoice_basis,
          materials_charge_ex_gst: charged
            ? materialsChargeDecision.authorisation.amount_ex_gst
            : 0,
          decision_key: charged
            ? materialsChargeDecision.authorisation.decision_key
            : materialsChargeDecision.clearance.decision_key,
        },
      ),
    };
  }
  if (row.invoice_basis === "roof_storey_fixed") {
    const storey = facts.storeys ??
      input.cycle_facts.roof_report_fields?.storeys;
    try {
      const price = roofReportPrice(storey);
      return {
        proposal: {
          version: "ses-local-invoice-proposal/v1",
          builder_reference: ref,
          basis: row.invoice_basis,
          storeys: price.storey,
          line_items: [
            lineItem(
              `${ref} - ${price.storey_label} roof report`,
              1,
              price.ex_gst,
            ),
          ],
          subtotal_ex_gst: price.ex_gst,
          gst: price.inc_gst - price.ex_gst,
          total_inc_gst: price.inc_gst,
          xero_identity: null,
        },
        blocker: null,
      };
    } catch {
      return {
        proposal: null,
        blocker: blocked(
          "pricing_evidence_missing",
          "Roof report pricing requires an explicit single/double storey fact.",
          "Record the source-evidenced storey classification and re-run.",
        ),
      };
    }
  }
  if (row.invoice_basis === "assessment_fixed") {
    if (typeof facts.fence_only !== "boolean") {
      return {
        proposal: null,
        blocker: blocked(
          "pricing_evidence_missing",
          "Assessment pricing requires the work order to state whether the scope is fence-only.",
          "Confirm from the work order whether the assessment is fence-only before selecting the $130 or $150 ex-GST price.",
        ),
      };
    }
    const fenceOnly = facts.fence_only;
    const ex = fenceOnly ? 130 : 150;
    return {
      proposal: {
        version: "ses-local-invoice-proposal/v1",
        builder_reference: ref,
        basis: row.invoice_basis,
        fence_only: fenceOnly,
        line_items: [
          lineItem(
            `${ref} - ${
              fenceOnly ? "Fence-only " : ""
            }assessment report and quote`,
            1,
            ex,
          ),
        ],
        subtotal_ex_gst: ex,
        gst: ex * 0.1,
        total_inc_gst: ex * 1.1,
        xero_identity: null,
      },
      blocker: null,
    };
  }

  const trades = nonNegativeInteger(facts.trades);
  // Two hours in, three hours out (Captain ruling 2026-08-02). The field report's
  // `hours_per_trade` is what the TRADE bills US - a cost fact. The builder minimum below is
  // what WE bill the builder - a revenue fact. They are two different commercial facts, and a
  // short attendance is the case the minimum exists for. So a report recording fewer hours than
  // the minimum is the NORMAL case, never missing evidence.
  const reportedHoursPerTrade = positiveNumber(facts.hours_per_trade);
  const canonicalRate = row.invoice_basis === "ajs_labour_materials" ||
      row.invoice_basis === "ajs_temporary_fence_labour_only"
    ? 80
    : 85;
  const minimum = row.family === "temporary_fencing" && trades === 1
    ? 4
    : canonicalRate === 80
    ? 2
    : 3;
  if (
    trades === null ||
    trades < 1 ||
    reportedHoursPerTrade === null
  ) {
    return {
      proposal: null,
      blocker: blocked(
        "pricing_evidence_missing",
        "Pricing requires a positive trade count and the attended hours for each trade.",
        "Recover the number of trades and the attended hours for each trade from the field report; do not invent either fact.",
      ),
    };
  }
  // Raise the COST hours to the sealed billable floor. This never lowers a longer attendance,
  // and it never reaches below the floor, so the sealed schedule is enforced, not bypassed: the
  // proposal that leaves here always declares >= `minimum` billable hours per trade and the
  // downstream money guard re-checks it independently.
  const hoursPerTrade = Math.max(reportedHoursPerTrade, minimum);
  const suppliedRate = facts.rate_ex_gst == null
    ? canonicalRate
    : positiveNumber(facts.rate_ex_gst);
  if (suppliedRate !== canonicalRate) {
    return {
      proposal: null,
      blocker: blocked(
        "pricing_evidence_missing",
        `Rate ${
          String(
            facts.rate_ex_gst,
          )
        } does not match the sealed $${canonicalRate} ex GST schedule.`,
        "Attach a line-specific audited rate override or use the canonical rate.",
      ),
    };
  }

  const lines: Array<Record<string, unknown>> = [
    lineItem(
      `${ref} - ${attendanceLineSubject(row.family)} - ${trades} trade${
        trades === 1 ? "" : "s"
      } x ${hoursPerTrade} hours`,
      trades * hoursPerTrade,
      canonicalRate,
    ),
  ];
  // Counted where the typed-materials loop actually pushes, never inferred by
  // subtracting a labour-line constant: a future travel or allowance line would
  // otherwise read as a priced materials line and disable the guard silently.
  let pricedMaterialsLineCount = 0;
  let existingFencePickets: number | null = null;
  if (
    row.invoice_basis === "ajs_labour_materials" &&
    text(facts.existing_fence_star_picket_refusal)
  ) {
    const refusal = text(facts.existing_fence_star_picket_refusal);
    const genuineKit = refusal === "genuine_temporary_fence_signal";
    return {
      proposal: null,
      blocker: blocked(
        "pricing_evidence_missing",
        genuineKit
          ? "The trade evidence describes a genuine temporary-fence kit, so AJS/AJBR pickets and the other kit materials remain non-billable."
          : "The star-picket material entry does not carry unambiguous existing-fence support and quantity evidence.",
        genuineKit
          ? "Bill evidenced labour and defensible travel only; do not turn panels, bases, ties, clips, fixings, consumables, hire or retrieval materials into invoice lines."
          : "Record one explicit existing-fence prop/support narrative and one positive star-picket quantity from the trade report before pricing the material.",
      ),
    };
  }
  if (row.invoice_basis === "ajs_labour_materials") {
    existingFencePickets = nonNegativeInteger(
      facts.existing_fence_star_picket_count,
    );
    if (
      Object.hasOwn(facts, "existing_fence_star_picket_count") &&
      (existingFencePickets === null || existingFencePickets < 1)
    ) {
      return {
        proposal: null,
        blocker: blocked(
          "pricing_evidence_missing",
          "The existing-fence star-picket quantity is not a positive whole number.",
          "Recover one positive star-picket quantity from the trade's materials-used evidence before pricing the material.",
        ),
      };
    }
    if (existingFencePickets && existingFencePickets > 0) {
      lines.push(
        lineItem(
          `${ref} - Star pickets supplied to prop and secure existing fence`,
          existingFencePickets,
          AJS_EXISTING_FENCE_STAR_PICKET_RATE_EX_GST,
        ),
      );
    }
  }
  if (row.family === "temporary_fencing") {
    const panelCount = nonNegativeInteger(facts.panel_count);
    const baseCount = nonNegativeInteger(facts.base_count);
    if (panelCount === null || panelCount < 1 || baseCount === null) {
      return {
        proposal: null,
        blocker: blocked(
          "pricing_evidence_missing",
          "Temporary-fencing pricing requires the number of panels and bases or blocks used.",
          "Recover the panel and base or block quantities from the work order or structured scope before pricing.",
        ),
      };
    }
    if (
      row.invoice_basis === "mlb_temporary_fence_hire" ||
      row.invoice_basis === "western_temporary_fence_hire"
    ) {
      const pickets = nonNegativeInteger(facts.star_picket_count);
      if (pickets === null) {
        return {
          proposal: null,
          blocker: blocked(
            "pricing_evidence_missing",
            "Hire-card temporary fencing requires the number of star pickets used, including zero.",
            "Recover the star-picket quantity from the work order or structured scope before pricing.",
          ),
        };
      }
      lines.push(
        lineItem(
          `${ref} - Temporary fencing retrieval, collection and loading allowance - 2 hours`,
          2,
          90,
        ),
        lineItem(
          `${ref} - Temporary fence hire: ${panelCount} panels x $5 per panel per week x 12 weeks`,
          12,
          panelCount * 5,
        ),
      );
      if (pickets > 0) {
        lines.push(
          lineItem(
            `${ref} - Star pickets supplied for temporary fencing make-safe`,
            pickets,
            13.5,
          ),
        );
      }
      lines.push(lineItem(`${ref} - Cable ties and small consumables`, 1, 25));
    }
  } else {
    const materials = Array.isArray(facts.materials) ? facts.materials : [];
    for (const raw of materials) {
      const material = raw && typeof raw === "object"
        ? (raw as Record<string, unknown>)
        : {};
      const description = text(material.description);
      const quantity = positiveNumber(material.quantity);
      const unitPrice = positiveNumber(material.unit_price_ex_gst);
      if (!description || quantity === null || unitPrice === null) {
        return {
          proposal: null,
          blocker: blocked(
            "pricing_evidence_missing",
            "A material proposal line lacks typed description, quantity or approved ex-GST unit price.",
            "Record material facts from source/trade evidence or remove the unsupported line.",
          ),
        };
      }
      if (row.invoice_basis === "ajs_labour_materials") {
        if (
          /\bcable ties?\b|\bclips?\b|\bfixings?\b|\bsmall consumables?\b/i
            .test(description)
        ) {
          return {
            proposal: null,
            blocker: blocked(
              "pricing_evidence_missing",
              "AJS/AJBR cable ties, clips, fixings and small consumables remain non-billable.",
              "Remove the refused material line and bill only evidenced labour, defensible travel and materials allowed by the sealed AJS/AJBR rule.",
            ),
          };
        }
        if (/\bstar(?:[\W_]+)?pickets?\b/i.test(description)) {
          if (
            existingFencePickets === null ||
            quantity !== existingFencePickets ||
            unitPrice !== AJS_EXISTING_FENCE_STAR_PICKET_RATE_EX_GST
          ) {
            return {
              proposal: null,
              blocker: blocked(
                "pricing_evidence_missing",
                "An AJS/AJBR star-picket material line cannot bypass the trade-evidenced existing-fence quantity and sealed $13.50 ex-GST rate.",
                "Derive the line from the trade report's materials-used evidence and the existing-fence support narrative.",
              ),
            };
          }
          // The canonical line above owns the wording and rate. A matching
          // typed material fact is corroboration, not a second invoice line.
          continue;
        }
      }
      lines.push(lineItem(`${ref} - ${description}`, quantity, unitPrice));
      pricedMaterialsLineCount += 1;
    }
  }

  // MLB / standard_labour_materials: never emit a silent labour-only proposal
  // when the trade recorded materials_used. No general materials unit-price
  // list exists — do not invent one. Either accept a priced materials line /
  // operator one-figure charge / recorded no-charge decision, or refuse with a
  // named ask-one-figure blocker.
  // AJS/AJBR (ajs_labour_materials) keep their picket carve-out unchanged.
  let materialsChargeMeta: Record<string, unknown> | null = null;
  if (row.invoice_basis === "standard_labour_materials") {
    const materialsDecision = decideStandardLabourMaterialsCharge({
      materials_used: recordedMaterialsFact(input),
      standing_decision: materialsChargeDecision,
      priced_materials_line_count: pricedMaterialsLineCount,
      invoiced_materials_evidence: invoicedMaterialsEvidence,
      released_cycle_evidence: releasedCycleEvidence,
      standing_decision_supplied_now: materialsChargeSuppliedNow,
    });
    if (materialsDecision.action === "refuse") {
      return {
        proposal: null,
        materials_charge_refused: true,
        blocker: blocked(
          materialsDecision.reason_code,
          materialsDecision.reason,
          materialsDecision.recovery_action,
          ["canonical-input-envelope", "trade-materials-used"],
          [],
          {
            materials_used: materialsDecision.materials,
            invoice_basis: row.invoice_basis,
            priced_materials_line_count: pricedMaterialsLineCount,
          },
        ),
      };
    }
    if (materialsDecision.action === "charge_line") {
      lines.push(
        lineItem(
          `${ref} - ${materialsDecision.description}`,
          1,
          materialsDecision.amount_ex_gst,
        ),
      );
      materialsChargeMeta = materialsDecision.provenance;
    }
    if (
      materialsDecision.action === "no_charge_recorded" ||
      materialsDecision.action === "already_invoiced" ||
      materialsDecision.action === "already_released"
    ) {
      // Both record an answer without adding money. `already_invoiced` is the
      // one that must not add a line: the charge is committed on the issued
      // invoice, so a second line here is what a later mint would double-bill.
      materialsChargeMeta = materialsDecision.provenance;
    }
  }

  const subtotal = Math.round(
    lines.reduce((sum, line) => sum + Number(line.amount_ex_gst || 0), 0) *
      100,
  ) / 100;
  return {
    proposal: {
      version: "ses-local-invoice-proposal/v1",
      builder_reference: ref,
      basis: row.invoice_basis,
      trades,
      // The trade's submitted cost hours are kept verbatim beside the billable hours so the two
      // facts stay separately auditable and neither can be mistaken for the other later.
      reported_hours_per_trade: reportedHoursPerTrade,
      billable_hours_per_trade: hoursPerTrade,
      billable_hours_floor: minimum,
      billable_hours_raised_to_floor: hoursPerTrade > reportedHoursPerTrade,
      line_items: lines,
      subtotal_ex_gst: subtotal,
      gst: Math.round(subtotal * 10) / 100,
      total_inc_gst: Math.round(subtotal * 110) / 100,
      xero_identity: null,
      ...(materialsChargeMeta ? { materials_charge: materialsChargeMeta } : {}),
    },
    blocker: null,
  };
}

function initialManifestItems(): Record<ManifestItem, SesObligationState> {
  return Object.fromEntries(
    MANIFEST_ITEMS.map((item) => [
      item,
      blocked(
        "recovery-not-run",
        "Evidence not recorded.",
        `Complete ${item} and record its evidence pointer.`,
      ),
    ]),
  ) as Record<ManifestItem, SesObligationState>;
}

const SPINE_MANIFEST_ITEMS = [
  "source_work_order_retrieval",
  "source_work_order_identity",
  "source_work_order_attachment",
  "instruction_deliverables",
  "lineage_review",
  "case_story_recovery",
  "exception_disposition",
  "hrcw_assessment",
  "swms_requirement",
] as const satisfies readonly ManifestItem[];

/**
 * Declared destination for an MLB physical report/photo route, or null when the
 * card is not on that shape (every other row keeps the work-order sender).
 *
 * One producer, three stores: this stamps the envelope, `buildEmailDrafts`
 * addresses the draft, and `resolveDocketRoutes` sets the resolved route — all
 * from `mlbPhysicalRouteRecipients`, so the operator's draft, the cockpit tab
 * and the send agree by construction rather than by coincidence.
 */
function mlbPhysicalDeclaredRouting(
  row: SesFamilyMatrixRow,
  kind: "report" | "photo",
): string | null {
  if (
    !isMlbPhysicalReleaseShape({
      builder_key: row.builder_key,
      family: row.family,
    })
  ) {
    return null;
  }
  if (kind === "photo" && row.photo_route !== "work_order_sender") return null;
  return mlbPhysicalRouteRecipients(kind, row.invoice_to).join(", ");
}

function routingBlocker(
  input: SesAssemblerInputV1,
  row: SesFamilyMatrixRow,
): SesBlocker | null {
  const missing: string[] = [];
  if (
    row.report_route === "work_order_sender" &&
    !input.source.work_order_sender
  ) {
    missing.push("makesafe_companies.report_recipient");
  }
  if (
    row.photo_route === "work_order_sender" &&
    !input.source.work_order_sender
  ) {
    missing.push("makesafe_companies.report_recipient");
  }
  if (row.invoice_route === "matrix_invoice_mailbox" && !row.invoice_to) {
    missing.push("sealed matrix invoice_to");
  }
  if (!missing.length) return null;
  return blocked(
    "routing_evidence_missing",
    `The sealed routing sources are incomplete: ${
      [...new Set(missing)].join(
        ", ",
      )
    }.`,
    "Complete the company routing table or seal the matrix row; never default an address.",
    ["makesafe_companies", `family-matrix:${SES_FAMILY_MATRIX_VERSION}`],
  );
}

function applySpineBlocker(manifest: SesManifestV2, blocker: SesBlocker): void {
  for (const item of SPINE_MANIFEST_ITEMS) {
    manifest.items[item] = blocker;
  }
  manifest.deliverables = manifest.deliverables.map((deliverable) => ({
    ...deliverable,
    completion: blocker,
  }));
}

function spineFactsComplete(input: SesAssemblerInputV1): boolean {
  return (
    !!text(input.identity.source_instruction_id) &&
    !!text(input.identity.lineage_id) &&
    /^sha256:[0-9a-f]{64}$/.test(text(input.identity.source_content_hash)) &&
    !!text(input.identity.job_id) &&
    !!text(input.source.builder_reference) &&
    input.source.attachment_pointers.length > 0 &&
    input.source.deliverables.length > 0 &&
    input.source.deliverables.every((deliverable) => !!text(deliverable.id))
  );
}

function portalSiblingCorrelationFacts(input: SesAssemblerInputV1): {
  job: boolean;
  source_instruction: boolean;
  lineage: boolean;
  source_content: boolean;
  attendance_cycle: boolean;
  typed_deliverables: boolean;
  source_attachments: boolean;
  reference_or_work_order: boolean;
} {
  const cycles = sortedUnique(input.attendance.attendance_cycle_ids || []);
  return {
    job: !!text(input.identity.job_id),
    source_instruction: !!text(input.identity.source_instruction_id),
    lineage: !!text(input.identity.lineage_id),
    source_content: /^sha256:[0-9a-f]{64}$/.test(
      text(input.identity.source_content_hash),
    ),
    attendance_cycle: input.attendance.attribution === "bound" &&
      !!text(input.attendance.current_attendance_cycle_id) &&
      cycles.includes(input.attendance.current_attendance_cycle_id),
    typed_deliverables: input.source.deliverables.length > 0 &&
      input.source.deliverables.every((deliverable) => !!text(deliverable.id)),
    source_attachments: input.source.attachment_pointers.length > 0,
    // The live adapter recovers this in the domain order supported by current
    // durable data: builder WO/reference, then PO, then external reference.
    // Address/client are not candidate-bound in the v1 link contract, so they
    // are never invented as tie-breakers.
    reference_or_work_order: !!text(input.source.builder_reference),
  };
}

function portalSiblingCorrelationComplete(
  facts: ReturnType<typeof portalSiblingCorrelationFacts>,
): boolean {
  return Object.values(facts).every(Boolean);
}

function markSpineEvidenceReady(
  manifest: SesManifestV2,
  input: SesAssemblerInputV1,
  swms: ReturnType<typeof swmsDecision>,
  sourcePaths: string[],
): void {
  manifest.items.source_work_order_retrieval = ready(
    `spine:source/${encodeURIComponent(input.identity.source_instruction_id)}`,
  );
  manifest.items.source_work_order_identity = ready(
    `spine:lineage/${encodeURIComponent(input.identity.lineage_id)}#job/${
      encodeURIComponent(
        input.identity.job_id,
      )
    }#hash/${input.identity.source_content_hash}#reference/${
      encodeURIComponent(
        input.source.builder_reference,
      )
    }`,
  );
  manifest.items.source_work_order_attachment = ready(
    `files:${sourcePaths.join(",")}`,
  );
  manifest.items.instruction_deliverables = ready(
    `spine:deliverables/${
      input.source.deliverables
        .map((deliverable) => encodeURIComponent(deliverable.id))
        .join(",")
    }`,
  );
  manifest.items.lineage_review = input.classification.lineage_kind === "none"
    ? notApplicable("no-related-docket-detected")
    : ready("file:case_story.json#lineage");
  manifest.items.case_story_recovery = ready("file:case_story.json");
  manifest.items.exception_disposition =
    input.classification.workflow === "active"
      ? notApplicable("ordinary-active-docket")
      : input.classification.workflow === "revision"
      ? notApplicable("ordinary-revision-docket")
      : blocked(
        "recovery-not-run",
        `${input.classification.workflow} requires a structured authority decision.`,
        "Record the workflow-compatible decision before review.",
      );
  manifest.items.hrcw_assessment = ready("file:case_story.json#hrcw");
  manifest.items.swms_requirement = ready(swms.requirementEvidence);
  manifest.deliverables = input.source.deliverables.map((deliverable) => ({
    ...deliverable,
    completion: ready(
      `spine:deliverable/${encodeURIComponent(deliverable.id)}`,
    ),
  }));
}

function hardStopManifest(
  input: SesAssemblerInputV1,
  applicabilityBlocker: SesBlocker,
): SesManifestV2 {
  const items = Object.fromEntries(
    MANIFEST_ITEMS.map((item) => [item, applicabilityBlocker]),
  ) as Record<ManifestItem, SesObligationState>;
  return {
    version: SES_MANIFEST_V2_VERSION,
    docket_id: input.identity.job_number || input.identity.job_id,
    classification: {
      workflow: input.classification.workflow,
      builder_key: input.classification.builder_key,
      family: input.classification.family,
      job_type: input.classification.family === "restoration"
        ? "restoration"
        : "unknown",
      recipe_selected: false,
      delivery_render_route: input.classification.delivery_render_route,
      delivery_render_route_reason_code:
        input.classification.delivery_render_route_reason_code,
      delivery_render_route_reason:
        input.classification.delivery_render_route_reason,
      delivery_render_route_evidence:
        input.classification.delivery_render_route_evidence,
      builder_reference: input.source.builder_reference,
      lineage: input.classification.lineage_kind,
    },
    routing: {
      builder: input.classification.builder_label,
      report_to: "",
      photo_to: "",
      invoice_to: "",
    },
    items,
    deliverables: input.source.deliverables.map((deliverable) => ({
      ...deliverable,
      completion: applicabilityBlocker,
    })),
  };
}

function manifestBase(
  input: SesAssemblerInputV1,
  row: SesFamilyMatrixRow,
  swms: ReturnType<typeof swmsDecision>,
): SesManifestV2 {
  const items = initialManifestItems();
  const routeFailure = routingBlocker(input, row);
  items.builder_routing = routeFailure ||
    ready(
      `company:${input.source.work_order_sender || "not-required"}#matrix:${
        row.invoice_to || "not-required"
      }#rule:${row.routing_rule}`,
    );
  items.supporting_invoice_pdf = blocked(
    "recovery-not-run",
    "Pre-Xero review carries a local proposal, never a Xero PDF.",
    "After Captain invoice-create approval, U5/U6 creates and binds the real invoice PDF.",
  );

  if (row.job_type !== "roof_report") {
    items.roof_report_link = notApplicable("not-a-roof-report");
    items.roof_report_capture = notApplicable("not-a-roof-report");
  }
  if (row.job_type !== "assessment_report_quote") {
    for (
      const item of [
        "assessment_report_link",
        "assessment_report_capture",
        "assessment_photos_link",
        "assessment_photos_capture",
        "assessment_scope_link",
        "assessment_scope_capture",
      ] as ManifestItem[]
    ) {
      items[item] = notApplicable("not-an-assessment-report");
    }
  }
  if (row.job_type !== "physical_makesafe") {
    items.physical_reporting_evidence = notApplicable(
      "report-only-has-no-physical-reporting-evidence",
    );
    items.draft_photo_evidence_email = notApplicable(
      "report-only-has-no-photo-email",
    );
  }
  if (row.job_type === "physical_makesafe") {
    items.supporting_portal_links = notApplicable(
      "physical-work-has-no-portal-deliverable",
    );
  }
  if (row.family === "ordinary_roof_portal") {
    items.supporting_report_pdf = notApplicable(
      "report-only-portal-is-the-report",
    );
    items.draft_builder_report_email = notApplicable("portal-is-the-report");
  }
  if (row.family === "assessment_quote") {
    items.supporting_report_pdf = notApplicable(
      "assessment-portal-is-the-report",
    );
    items.draft_builder_report_email = notApplicable(
      "assessment-prime-triad-is-the-report",
    );
  }
  if (row.family === "own_template_roof") {
    items.supporting_portal_links = notApplicable(
      "own-document-has-no-portal-deliverable",
    );
    items.roof_report_link = notApplicable("roof-report-on-own-letterhead");
    items.roof_report_capture = notApplicable("roof-report-on-own-letterhead");
  }
  if (!swms.required && swms.naRule) {
    items.swms_artifact = notApplicable(swms.naRule);
  }

  return {
    version: SES_MANIFEST_V2_VERSION,
    docket_id: input.identity.job_number || input.identity.job_id,
    classification: {
      workflow: input.classification.workflow,
      builder_key: row.builder_key,
      family: row.family,
      job_type: row.job_type,
      subtype: row.subtype,
      recipe_selected: true,
      delivery_render_route: input.classification.delivery_render_route,
      delivery_render_route_reason_code:
        input.classification.delivery_render_route_reason_code,
      delivery_render_route_reason:
        input.classification.delivery_render_route_reason,
      delivery_render_route_evidence:
        input.classification.delivery_render_route_evidence,
      ...(row.report_delivery ? { report_delivery: row.report_delivery } : {}),
      ...(row.family === "assessment_quote"
        ? {
          assessment_outbound_recipe_version: SES_ASSESSMENT_RECIPE_VERSION,
        }
        : {}),
      ...(row.family === "repair" || row.family === "restoration"
        ? {
          physical_family_recipe_version: SES_PHYSICAL_FAMILY_RECIPE_VERSION,
        }
        : {}),
      builder_reference: input.source.builder_reference,
      report_only: row.report_only,
      lineage: input.classification.lineage_kind,
      swms_required: swms.required,
      hrcw: input.hrcw.hrcw,
      hrcw_categories: [...input.hrcw.categories],
      source_hazard_terms: [...input.hrcw.source_hazard_terms],
      required_deliverable_ids: input.source.deliverables.map(
        (item) => item.id,
      ),
    },
    routing: {
      builder: input.classification.builder_label,
      // MLB physical report/photo go to the sealed Prime mailer (Captain
      // 2026-08-06), not to the company work-order sender — which for MLB is
      // the billing mailbox and is why all three emails used to land there.
      // Declared here from the same producer the drafts and the resolved routes
      // use, so the envelope, the draft and the send state one address.
      report_to: mlbPhysicalDeclaredRouting(row, "report") ??
        (row.report_route === "work_order_sender"
          ? input.source.work_order_sender || ""
          : ""),
      photo_to: mlbPhysicalDeclaredRouting(row, "photo") ??
        (row.photo_route === "work_order_sender"
          ? input.source.work_order_sender || ""
          : ""),
      invoice_to: row.invoice_to || "",
      // Intake-thread coordinates for MLB physical report/photo reply.
      // Two-tier authority (never internet_message_id): makesafe_intake_case_sources
      // .thread_id first and always when any source row exists; only a card with
      // ZERO source rows recovers from its approved makesafe_intake_draft via
      // emails(post_id = graph_message_id), selected by corroboration then intake
      // case story match, refusing when still ambiguous. See ses_mlb_thread_reply.
      intake_thread_id: input.source.intake_thread_id || "",
      intake_post_id: input.source.intake_post_id || "",
      intake_conversation_id: input.source.intake_conversation_id || "",
      // Verbatim original WO subject (emails.subject preferred). Used only for
      // MLB ordinary-mail report/photo inbox grouping — not real threading.
      intake_email_subject: input.source.intake_email_subject || "",
      intake_email_subject_source: input.source.intake_email_subject_source ||
        "",
    },
    items,
    deliverables: input.source.deliverables.map((deliverable) => ({
      ...deliverable,
      completion: blocked(
        "recovery-not-run",
        "Deliverable identity has not been proven against the complete correlation spine.",
        "Recover the exact source, lineage, content hash, builder reference and source attachment.",
      ),
    })),
  };
}

function addBlocker(blockers: SesBlocker[], blocker: SesBlocker): SesBlocker {
  if (
    !blockers.some(
      (candidate) =>
        candidate.reason_code === blocker.reason_code &&
        candidate.reason === blocker.reason,
    )
  ) {
    blockers.push(blocker);
  }
  return blocker;
}

function portalRoleItems(
  role: "roof_report" | "assessment" | "photos" | "scope",
): [ManifestItem, ManifestItem] {
  if (role === "roof_report") {
    return ["roof_report_link", "roof_report_capture"];
  }
  if (role === "assessment") {
    return ["assessment_report_link", "assessment_report_capture"];
  }
  if (role === "photos") {
    return ["assessment_photos_link", "assessment_photos_capture"];
  }
  return ["assessment_scope_link", "assessment_scope_capture"];
}

function inputPortalRole(
  role: SesAssemblerInputV1["source"]["portal_links"][number]["role"],
): "roof_report" | "assessment" | "photos" | "scope" | "other" {
  if (role === "quote") return "scope";
  if (role === "builder_portal") return "other";
  return role;
}

function portalRoleCardLabel(
  role: "roof_report" | "assessment" | "photos" | "scope",
): string {
  if (role === "assessment") return "assessment";
  if (role === "photos") return "photos";
  if (role === "scope") return "quote/scope";
  return "roof report";
}

function isValidContentFingerprint(value: unknown): value is SesSha256 {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function captureBlocker(capture: SesPortalCapture): SesBlocker | null {
  const role = capture.role === "assessment"
    ? "assessment"
    : capture.role === "photos"
    ? "photos"
    : capture.role === "scope"
    ? "quote/scope"
    : "roof report";
  if (capture.status === "missing") {
    return blocked(
      "portal_capture_missing",
      capture.signal,
      `Capture and persist the exact ${role} evidence for this job, current attendance cycle, role and source URL, then retry U4.`,
      [`portal-capture:${capture.role}`],
    );
  }
  if (capture.status === "invalid") {
    return blocked(
      "portal_capture_invalid",
      capture.signal ||
        `The persisted ${role} capture failed provenance validation.`,
      `Re-capture and persist valid ${role} evidence with actor, timestamp, source URL and content hash.`,
      [`portal-capture:${capture.role}`],
    );
  }
  if (capture.status === "done") {
    if (
      !isValidContentFingerprint(capture.content_fingerprint) ||
      !capture.captured_by.trim() ||
      !capture.capture_producer.trim() ||
      !capture.evidence_revision_id.trim()
    ) {
      return blocked(
        "portal_capture_invalid",
        `The ${role} capture returned done without complete persisted provenance and a valid content fingerprint.`,
        "Re-run the approved portal capture and persist the actor, timestamp, source URL, content hash and tied screenshot.",
        [`portal-capture:${capture.role}`],
      );
    }
    return null;
  }
  if (capture.status === "not_done") {
    return blocked(
      "portal_not_submitted",
      `The builder's ${role} form is not submitted and locked: ${
        capture.signal || "no locked/submitted banner"
      }.`,
      `Ask the trade to finish the ${role} form in Prime, then run the headless capture again.`,
      [`portal-capture:${capture.role}`],
    );
  }
  return blocked(
    "portal_unreachable",
    /expired|no longer active|no longer available/i.test(capture.signal || "")
      ? `The builder's ${role} link is expired - ask the builder to send a fresh ${role} link.`
      : `The builder's ${role} link could not be opened - ask the builder to send a working ${role} link.`,
    `Recover the ${role} link, then run the headless capture again.`,
    [`portal-capture:${capture.role}`],
  );
}

function draftEmail(args: {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  attachments: string[];
}): string {
  return [
    `To: ${args.to}`,
    `Cc: ${args.cc || ""}`,
    `Subject: ${args.subject}`,
    `Attachments: ${args.attachments.join(", ")}`,
    "",
    args.body,
  ].join("\n");
}

function buildEmailDrafts(
  input: SesAssemblerInputV1,
  row: SesFamilyMatrixRow,
  reportFile: string | null,
  swmsFile: string | null,
  photoFiles: string[],
  invoiceProposal: Record<string, unknown> | null,
): Record<string, string> {
  if (!invoiceProposal) {
    return {};
  }
  const ref = input.source.builder_reference;
  const address = [input.source.site_address, input.source.site_suburb]
    .filter(Boolean)
    .join(", ");
  const reportTo = input.source.work_order_sender || "";
  const invoiceTo = row.invoice_to || "";
  const invoiceAttachments = [
    ...(reportFile ? [reportFile] : []),
    ...(swmsFile ? [swmsFile] : []),
  ];
  if (row.family === "assessment_quote") {
    return {
      INVOICE_EMAIL_DRAFT: draftEmail({
        to: invoiceTo,
        cc: "finance@secureworkswa.com.au",
        subject: `${ref} - assessment report and quote invoice`,
        body:
          "Draft only. The assessment, photo schedule and quote have been completed and submitted through Prime. No authorised Xero invoice exists yet, so no invoice is attached. No SWMS, local report or separate photo pack applies to this assessment card.",
        attachments: [],
      }),
    };
  }
  if (row.family !== "ordinary_roof_portal" && !reportFile) {
    return {};
  }

  // AJS/AJBR two-email shape (Captain 2026-08-04): combined report+invoice, then photos.
  // MLB physical three-email shape (Captain 2026-08-05): report + photo as intake
  // thread replies; invoice is the billing pack (report + SWMS + AUTHORISED invoice)
  // to makesafes@. Other builders keep the universal three-email split.
  const ajs = isAjsBuilderKey(row.builder_key);
  if (ajs) {
    // Builder-facing copy only: what is attached, job ref, thanks.
    // No internal vocabulary (draft, docket, pack, route, cycle, revision).
    const drafts: Record<string, string> = {};
    const ajsCc = ajsPackCc().join(", ");
    if (reportFile) {
      drafts.REPORT_EMAIL_DRAFT = draftEmail({
        to: [invoiceTo || "workorders@ajs.build", reportTo].filter(Boolean)
          .join(", "),
        cc: ajsCc,
        subject: `${ref} - report and invoice`,
        body:
          `Please find attached the report and invoice for ${ref}.\n\nThank you.`,
        attachments: [
          reportFile,
          ...invoiceAttachments.filter((name) => name !== reportFile),
        ],
      });
    }
    if (row.photo_route === "work_order_sender" && photoFiles.length > 0) {
      drafts.PHOTO_EMAIL_DRAFT = draftEmail({
        to: [invoiceTo || "workorders@ajs.build", reportTo].filter(Boolean)
          .join(", "),
        cc: ajsCc,
        subject: `Photo Evidence - ${ref}`,
        body: `Please find attached site photos for ${ref}.\n\nThank you.`,
        attachments: photoFiles,
      });
    }
    return drafts;
  }

  // Same family set the release shape and the envelope routing use — declared
  // once in ses_mlb_thread_reply so the three producers cannot drift apart.
  const mlbPhysical = isMlbPhysicalReleaseShape({
    builder_key: row.builder_key,
    family: row.family,
  });

  // Captain 2026-08-06: MLB physical report and photo go to the Prime mailer;
  // only the billing pack goes to makesafes@. Both destinations come from the
  // one producer that resolveDocketRoutes uses, so the draft the operator reads
  // and the route that actually sends state the same address. Other builders on
  // the universal split (and MLB report-only families) keep the work-order
  // sender from makesafe_companies.report_recipient.
  const reportPhotoTo = mlbPhysical
    ? mlbPhysicalRouteRecipients("report", invoiceTo).join(", ")
    : reportTo;

  // MLB ordinary Mail.Send (Captain exception): report/photo use the EXACT
  // original WO email subject so mail clients can group them next to the WO.
  // This is inbox grouping only — not real threading (group-thread reply is
  // Application: Not supported). Re: is neither added nor stripped; missing
  // original falls back to the generated subject and still drafts.
  const ordinaryMailSubjectMatch = mlbPhysical &&
    mlbPhysicalUsesOrdinaryMailSendFallback();
  const originalWoSubject = text(input.source.intake_email_subject);
  const originalSubjectSource = input.source.intake_email_subject_source ||
    null;
  const reportGenerated = `${ref} - ${row.family.replaceAll("_", " ")}`;
  const photoGenerated = `Photo Evidence - ${ref}`;
  const reportSubject = ordinaryMailSubjectMatch
    ? mlbOrdinaryMailSubject(
      originalWoSubject,
      reportGenerated,
      originalSubjectSource,
    ).subject
    : reportGenerated;
  const photoSubject = ordinaryMailSubjectMatch
    ? mlbOrdinaryMailSubject(
      originalWoSubject,
      photoGenerated,
      originalSubjectSource,
    ).subject
    : photoGenerated;

  const invoice = draftEmail({
    to: invoiceTo,
    cc: "finance@secureworkswa.com.au",
    subject: mlbPhysical
      ? `${ref} - billing pack (report, SWMS, invoice)`
      : `${ref} - invoice proposal`,
    body: mlbPhysical
      ? "Draft only. Billing pack for makesafes@: make-safe report, SWMS, and the authorised Xero invoice. No release is approved until the invoice is AUTHORISED."
      : "Draft only. This docket contains internal pre-Xero pricing state. No Xero invoice exists and no release is approved.",
    attachments: invoiceAttachments,
  });
  const drafts: Record<string, string> = { INVOICE_EMAIL_DRAFT: invoice };
  if (reportFile) {
    drafts.REPORT_EMAIL_DRAFT = draftEmail({
      to: reportPhotoTo,
      subject: reportSubject,
      body: mlbPhysical
        ? ordinaryMailSubjectMatch
          ? `Draft only. Report pack for ${
            address || "the instructed property"
          }. Ordinary Mail.Send (group-thread reply is Application: Not supported); subject matches the original work-order email for inbox grouping only — not real threading. Photos and the billing pack travel on separate routes.`
          : `Draft only. Report-only reply on the work-order intake thread for ${
            address || "the instructed property"
          }. Photos and the billing pack travel on separate routes.`
        : `Draft only. Please find the prepared ${
          row.family.replaceAll(
            "_",
            " ",
          )
        } evidence for ${address || "the instructed property"}.`,
      attachments: [reportFile],
    });
  }
  if (row.photo_route === "work_order_sender" && photoFiles.length > 0) {
    drafts.PHOTO_EMAIL_DRAFT = draftEmail({
      to: reportPhotoTo,
      subject: photoSubject,
      body: mlbPhysical
        ? ordinaryMailSubjectMatch
          ? "Draft only. Photo pack. Ordinary Mail.Send; subject matches the original work-order email for inbox grouping only — not real threading. The complete, ordered original photo set is listed on the docket."
          : "Draft only. Photos-only reply on the work-order intake thread. The complete, ordered original photo set is listed on the docket."
        : "Draft only. The complete, ordered original photo set is listed on the docket.",
      attachments: photoFiles,
    });
  }
  return drafts;
}

function reviewHtml(
  input: SesAssemblerInputV1,
  family: string,
  blockers: SesBlocker[],
  drafts: Record<string, string>,
): string {
  const escape = (value: unknown) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${
    escape(
      input.source.builder_reference,
    )
  } SES docket</title></head>
<body data-assembler="${SES_ASSEMBLER_VERSION}">
<main><h1>${escape(input.source.builder_reference)}</h1>
<p>Family: ${escape(family)}</p>
<p>State: ${blockers.length ? "BLOCKED" : "PRE-XERO DOCS READY"}</p>
<section id="blockers"><h2>Blockers</h2><pre>${
    escape(
      canonicalSesJson(blockers),
    )
  }</pre></section>
<section id="email-drafts"><h2>Email drafts</h2>${
    Object.entries(drafts)
      .map(
        ([name, body]) =>
          `<article><h3>${escape(name)}</h3><pre>${
            escape(body)
          }</pre></article>`,
      )
      .join("")
  }</section>
</main></body></html>`;
}

function validatePreXero(
  manifest: SesManifestV2,
  proposal: Record<string, unknown> | null,
  artifacts: SesArtifact[],
  blockers: SesBlocker[],
): boolean {
  if (blockers.length || !proposal) return false;
  const required = MANIFEST_ITEMS.filter(
    (name) => name !== "supporting_invoice_pdf",
  );
  if (required.some((name) => manifest.items[name]?.state === "blocked")) {
    return false;
  }
  if (!artifacts.some((artifact) => artifact.role === "invoice_proposal")) {
    return false;
  }
  return true;
}

function responseSummary(results: SesPreparedRevision[]) {
  const values = results
    .map((result) => result.timing.duration_ms)
    .sort((a, b) => a - b);
  const index = values.length
    ? Math.max(0, Math.ceil(values.length * 0.95) - 1)
    : 0;
  return {
    count: values.length,
    max_ms: values.length ? values[values.length - 1] : 0,
    p95_ms: values.length ? values[index] : 0,
    all_within_five_minutes: results.every(
      (result) => result.timing.within_five_minutes,
    ),
  };
}

function validateRequest(request: SesPrepareRequest): void {
  if (request.assembler_version !== SES_ASSEMBLER_VERSION) {
    throw new TypeError(`assembler_version must be ${SES_ASSEMBLER_VERSION}`);
  }
  if (!text(request.idempotency_key)) {
    throw new TypeError("idempotency_key is required");
  }
  const mode = request.selection?.mode;
  if (mode === "job_id") {
    if (
      !text(request.selection.job_id) ||
      request.selection.job_number ||
      request.selection.limit
    ) {
      throw new TypeError("job_id selection requires only job_id");
    }
    return;
  }
  if (mode === "job_number") {
    if (
      !text(request.selection.job_number) ||
      request.selection.job_id ||
      request.selection.limit
    ) {
      throw new TypeError("job_number selection requires only job_number");
    }
    return;
  }
  if (mode === "board_batch") {
    const limit = Number(request.selection.limit);
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      request.selection.job_id ||
      request.selection.job_number
    ) {
      throw new TypeError("board_batch requires limit between 1 and 50");
    }
    // One authorised materials figure describes one card's materials. Spreading
    // it across a batch would bill cards nobody priced, and withdrawing across
    // a batch would strip figures from cards nobody reviewed.
    if (request.materials_charge || request.materials_charge_cleared) {
      throw new TypeError(
        "materials_charge requires a job_id or job_number selection",
      );
    }
    return;
  }
  throw new TypeError("selection.mode is invalid");
}

async function prepareOne(
  request: SesPrepareRequest,
  selection:
    | { mode: "job_id"; job_id: string }
    | {
      mode: "job_number";
      job_number: string;
    },
  deps: SesPrepareDependencies,
): Promise<SesPreparedRevision> {
  const now = deps.now || (() => new Date());
  const acceptedAt = now();
  const stagesMs: Record<string, number> = {};
  const degradedCapabilities: string[] = [];
  const measure = async <T>(
    stage: string,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const started = now().getTime();
    try {
      return await fn();
    } finally {
      stagesMs[stage] = Math.max(0, now().getTime() - started);
    }
  };

  stagesMs.T0 = 0;
  const input = await measure("T1", () => deps.resolveInput(selection));
  const blockers = inputBlockers(input);
  const matrix = resolveSesFamilyMatrixRow({
    builder_key: input.classification.builder_key,
    family: input.classification.family,
    strata: input.classification.strata,
    own_template_requested: input.classification.own_template_requested,
    site_suburb: input.source.site_suburb,
  });
  // The card carries a standing materials-charge decision — UNSET, SET or
  // NONE — and it changes what the invoice says, so the decided states belong
  // inside the revision identity. UNSET wraps nothing, which keeps the ordinary
  // hash byte-identical and churns no existing Docs Ready signoff.
  //
  // An OMITTED body key inherits whatever this card's newest revision decided
  // for the same attendance cycle and the same recorded materials, in either
  // direction: a figure keeps billing and a withdrawal keeps not billing. Only
  // an explicit body value moves the decision. Inheritance is bounded to the
  // basis whose pricing has a charge line at all, so a card reclassified onto
  // another basis cannot carry a stale decision into a refusal nobody asked for.
  let materialsChargeDecision: SesMaterialsChargeStandingDecision | null =
    request.materials_charge
      ? { decision: "charge", authorisation: request.materials_charge }
      : request.materials_charge_cleared
      ? { decision: "none", clearance: request.materials_charge_cleared }
      : null;
  if (
    !materialsChargeDecision &&
    matrix.ok &&
    matrix.row.invoice_basis === "standard_labour_materials" &&
    deps.resolvePriorMaterialsCharge &&
    recordedMaterialsUsed(recordedMaterialsFact(input)).length > 0
  ) {
    materialsChargeDecision = carriedMaterialsChargeDecision({
      prior_materials_charge: await deps.resolvePriorMaterialsCharge({
        job_id: input.identity.job_id,
        attendance_cycle_id: input.attendance.current_attendance_cycle_id,
      }),
      materials_used: recordedMaterialsFact(input),
    });
  }
  // Nobody has answered, so ask the money. An issued invoice that itemises
  // materials is a human's committed answer to exactly this question, and it
  // outranks a figure typed onto a docket because a builder was billed for it.
  //
  // The lookup is bounded to the case where it can actually decide something:
  // no standing decision, the one basis that hosts a materials charge, recorded
  // materials to answer for, and NO typed material facts. That last condition
  // is what keeps a card that prices correctly today byte-identical — its
  // proposal already carries priced materials lines, the evidence would be
  // ignored downstream, and folding it into the hash below would re-key the
  // revision and drop its Docs Ready signoff for no pricing effect.
  let invoicedMaterialsEvidence: SesInvoicedMaterialsEvidence | null = null;
  let releasedCycleEvidence: SesReleasedCycleEvidence | null = null;
  if (
    matrix.ok &&
    matrix.row.invoice_basis === "standard_labour_materials" &&
    deps.resolveMaterialsAnswerEvidence &&
    recordedMaterialsUsed(recordedMaterialsFact(input)).length > 0 &&
    !typedMaterialFactsPresent(input)
  ) {
    const reading = await deps.resolveMaterialsAnswerEvidence({
      job_id: input.identity.job_id,
      attendance_cycle_id: input.attendance.current_attendance_cycle_id,
    });
    releasedCycleEvidence = reading?.released?.kind === "released"
      ? reading.released.evidence
      : null;
    invoicedMaterialsEvidence = reading?.invoiced?.kind === "evidence"
      ? reading.invoiced.evidence
      : null;
  }
  // Both readings answer an UNANSWERED question, so a card already carrying a
  // decision drops them entirely. That is what keeps the two shipped cards that
  // already price a materials line (Mosman Park SWMS-261147, Gidgegannup
  // SWMS-26953) byte-identical: they reproduce the figure they shipped under
  // instead of being re-keyed to say something else. The one exception is a
  // figure supplied on THIS request against a released cycle, which the guard
  // refuses — and which already carries its own identity through
  // `operator_materials_charge` below.
  const materialsQuestionAnswered = materialsChargeDecision !== null;
  const suppliedMaterialsChargeNow = Boolean(
    request.materials_charge || request.materials_charge_cleared,
  );
  if (materialsQuestionAnswered && !suppliedMaterialsChargeNow) {
    releasedCycleEvidence = null;
    invoicedMaterialsEvidence = null;
  }
  if (materialsQuestionAnswered) invoicedMaterialsEvidence = null;
  // A card that the money or the send has already settled is a different
  // revision from the same card before that happened, so the fact that it
  // settled belongs inside the identity: without it a blocked revision and the
  // settled one collide on a single revision id. Absent evidence wraps nothing,
  // which keeps every card that still has to be priced byte-identical to today.
  //
  // Only a MINIMAL, stable coordinate goes in. The full evidence is recorded on
  // the marker for audit, but proof timestamps, route kinds, invoice status and
  // line detail all legitimately move AFTER settlement (a later route proof, the
  // mirror flipping AUTHORISED to PAID), and each such move would re-key an
  // already-shipped revision, reopen its pack as needs_review and drop a Docs
  // Ready signoff the Captain has already given.
  const inputContentHash = await sesSha256(
    materialsChargeDecision === null && releasedCycleEvidence
      ? {
        input,
        settled_attendance_cycle_id:
          input.attendance.current_attendance_cycle_id,
      }
      : materialsChargeDecision?.decision === "charge"
      ? {
        input,
        operator_materials_charge: materialsChargeDecision.authorisation,
      }
      : materialsChargeDecision?.decision === "none"
      ? { input, materials_charge_cleared: materialsChargeDecision.clearance }
      : invoicedMaterialsEvidence
      ? {
        input,
        already_invoiced_materials: {
          invoice_id: invoicedMaterialsEvidence.invoice_id,
          invoice_number: invoicedMaterialsEvidence.invoice_number,
          materials_ex_gst: invoicedMaterialsEvidence.materials_ex_gst,
        },
      }
      : input,
  );
  if (!request.force_refresh && deps.findCurrentRevision) {
    const current = await deps.findCurrentRevision(
      input.identity.job_id,
      inputContentHash,
    );
    if (current) return current;
  }

  stagesMs.T2 = 0;
  let applicabilityBlocker: SesBlocker | null = null;
  if (!matrix.ok) {
    applicabilityBlocker = addBlocker(
      blockers,
      blocked(
        matrix.failure.code,
        matrix.failure.reason,
        matrix.failure.recovery_action,
        ["canonical-input-envelope", "sealed-family-matrix"],
      ),
    );
  }
  const row = matrix.ok ? matrix.row : null;
  if (
    matrix.ok &&
    (input.classification.report_only !== matrix.row.report_only ||
      input.classification.report_delivery !== matrix.row.report_delivery ||
      input.classification.subtype !== matrix.row.subtype ||
      (input.classification.family === "temporary_fencing" &&
        input.classification.subtype !== "temporary_fencing"))
  ) {
    addBlocker(
      blockers,
      blocked(
        "input_hash_conflict",
        "The input classification fields do not match the sealed builder-family matrix row.",
        "Refresh the versioned U1/U2 assembler envelope; do not repair classification inside U4.",
      ),
    );
  }
  if (!request.dry_run && !deps.persist) {
    degradedCapabilities.push("docket_persistence");
    addBlocker(
      blockers,
      blocked(
        "capability_board_fatal",
        "Draft revision persistence capability is unavailable.",
        "Resume with the append-only makesafe_docket_revisions persistence adapter.",
      ),
    );
  }

  const swms = row ? swmsDecision(input, row) : null;
  const manifest = row && swms
    ? manifestBase(input, row, swms)
    : hardStopManifest(input, applicabilityBlocker!);
  if (row) {
    const routeFailure = routingBlocker(input, row);
    if (
      routeFailure &&
      !blockers.some(
        (candidate) => candidate.reason_code === routeFailure.reason_code,
      )
    ) {
      addBlocker(blockers, routeFailure);
    }
  }
  const inputSpineBlocker = blockers.find(
    (candidate) =>
      candidate.reason_code === "spine_missing_lineage" ||
      candidate.reason_code === "spine_missing_source" ||
      candidate.reason_code === "spine_missing_deliverables",
  );
  if (row && inputSpineBlocker) {
    applySpineBlocker(manifest, inputSpineBlocker);
  }
  const artifacts: SesArtifact[] = [];
  let persistenceRefused = false;
  const portalEvidence: SesPortalCapture[] = [];
  let reportFile: string | null = null;
  let swmsFile: string | null = null;
  const photoFiles: string[] = [];

  await measure("T3", async () => {
    if (!row || !swms) return;
    if (!deps.resolveSourceArtifacts) {
      const sourceBlocker = addBlocker(
        blockers,
        blocked(
          "spine_missing_source",
          "Source attachment recovery capability is unavailable.",
          "Resume with the canonical U1 case-source attachment adapter.",
        ),
      );
      manifest.items.source_work_order_retrieval = sourceBlocker;
      manifest.items.source_work_order_attachment = sourceBlocker;
      return;
    }
    const resolved = await deps.resolveSourceArtifacts(input);
    const expected = new Set(input.source.attachment_pointers);
    const recovered = new Set(
      resolved.map((artifact) => artifact.source_pointer),
    );
    const missing = [...expected].filter((pointer) => !recovered.has(pointer));
    let recoveryComplete = !missing.length &&
      resolved.length === expected.size && expected.size > 0;
    const sourcePaths: string[] = [];
    if (missing.length) {
      const sourceBlocker = addBlocker(
        blockers,
        blocked(
          "spine_missing_source",
          `Canonical source recovery did not return ${missing.length} referenced attachment(s).`,
          "Recover every designated source attachment from the exact U1 case-source ledger.",
          ["canonical-input-envelope", "case-source-attachment-ledger"],
          missing,
        ),
      );
      manifest.items.source_work_order_retrieval = sourceBlocker;
      manifest.items.source_work_order_attachment = sourceBlocker;
    }
    for (const source of resolved) {
      if (
        !expected.has(source.source_pointer) ||
        !text(source.file_name) ||
        source.file_name.includes("/") ||
        source.file_name.includes("..") ||
        !source.bytes.byteLength
      ) {
        recoveryComplete = false;
        const sourceBlocker = addBlocker(
          blockers,
          blocked(
            "spine_missing_source",
            "Recovered source artifact did not match a designated pointer or safe file name.",
            "Reject the artifact and re-read the exact U1 case-source attachment.",
            ["case-source-attachment-ledger"],
            [source.source_pointer],
          ),
        );
        manifest.items.source_work_order_retrieval = sourceBlocker;
        manifest.items.source_work_order_attachment = sourceBlocker;
        continue;
      }
      const sourcePath = `SOURCE/${source.file_name}`;
      sourcePaths.push(sourcePath);
      artifacts.push(
        await artifactFromBytes({
          role: "source_attachment",
          path: sourcePath,
          media_type: source.media_type,
          bytes: source.bytes,
          metadata: { source_pointer: source.source_pointer },
        }),
      );
    }
    if (
      recoveryComplete &&
      sourcePaths.length === expected.size &&
      new Set(sourcePaths).size === sourcePaths.length &&
      spineFactsComplete(input)
    ) {
      markSpineEvidenceReady(manifest, input, swms, sourcePaths.sort());
    }
  });

  await measure("T4", async () => {
    if (
      !row ||
      input.classification.delivery_render_route !== "builder_portal"
    ) return;
    for (const role of row.required_portal_roles) {
      const matches = input.source.portal_links.filter(
        (link) => inputPortalRole(link.role) === role,
      ).sort((left, right) => left.url.localeCompare(right.url));
      const [linkItem, captureItem] = portalRoleItems(role);
      const siblingInventory = row.family === "ordinary_roof_portal" &&
        input.source.portal_links.length > 1;
      const correlationFacts = portalSiblingCorrelationFacts(input);
      const correlationComplete = portalSiblingCorrelationComplete(
        correlationFacts,
      );
      if (
        matches.length !== 1 ||
        (siblingInventory && !correlationComplete)
      ) {
        const code = matches.length
          ? "portal_wrong_reference"
          : "portal_link_absent";
        const itemBlocker = addBlocker(
          blockers,
          blocked(
            code,
            matches.length
              ? matches.length === 1
                ? `Portal role ${role} has one typed candidate among ${input.source.portal_links.length} genuine links, but its current job, source instruction, attendance cycle and reference correlation spine is incomplete.`
                : `Portal role ${role} has ${matches.length} equally credible candidates; exactly one is required.`
              : `The work order email contains no ${
                portalRoleCardLabel(
                  role,
                )
              } link - ask the builder to send it.`,
            `Recover and bind exactly one typed ${
              portalRoleCardLabel(
                role,
              )
            } link from the source instruction.`,
            [
              "canonical-input-envelope",
              `portal-role:${role}`,
              ...(matches.length === 1
                ? [
                  "correlation:job",
                  "correlation:source-instruction",
                  "correlation:attendance-cycle",
                  "correlation:reference-or-work-order",
                ]
                : []),
            ],
            (matches.length === 1 ? input.source.portal_links : matches).map((
              link,
            ) => link.url).sort(),
            matches.length === 1
              ? { correlation: correlationFacts }
              : { candidate_count: matches.length, role },
          ),
        );
        manifest.items[linkItem] = itemBlocker;
        manifest.items[captureItem] = itemBlocker;
        continue;
      }
      const link = matches[0];
      manifest.items[linkItem] = ready(`url:${link.url}`);
      if (!deps.capturePortal) {
        degradedCapabilities.push("portal_capture");
        const itemBlocker = addBlocker(
          blockers,
          blocked(
            "capability_portal_degraded",
            "Headless portal capture capability is unavailable.",
            "Resume on the approved capture_portal_evidence runner; never infer portal state.",
            [`portal-role:${role}`],
          ),
        );
        manifest.items[captureItem] = itemBlocker;
        continue;
      }
      let capture: SesPortalCapture;
      try {
        capture = await deps.capturePortal({
          job_id: input.identity.job_id,
          docket_id: manifest.docket_id,
          builder_reference: input.source.builder_reference,
          role,
          url: link.url,
          idempotency_key: `${request.idempotency_key}:portal:${role}`,
        });
      } catch (error) {
        capture = {
          status: "invalid",
          role,
          url: link.url,
          docket_id: manifest.docket_id,
          job_id: input.identity.job_id,
          builder_reference: input.source.builder_reference,
          captured_at: now().toISOString(),
          captured_by: "",
          capture_producer: "",
          evidence_revision_id: "",
          content_fingerprint: await sesSha256({
            role,
            url: link.url,
            error: error instanceof Error ? error.message : String(error),
          }),
          idempotency_key: `${request.idempotency_key}:portal:${role}`,
          signal: error instanceof Error ? error.message : String(error),
        };
      }
      const screenshotBytes = capture.screenshot_bytes;
      const { screenshot_bytes: _discardedScreenshotBytes, ...captureRecord } =
        capture;
      portalEvidence.push(captureRecord);
      if (
        capture.role !== role ||
        capture.url !== link.url ||
        capture.job_id !== input.identity.job_id ||
        capture.docket_id !== manifest.docket_id ||
        capture.builder_reference !== input.source.builder_reference
      ) {
        const itemBlocker = addBlocker(
          blockers,
          blocked(
            "portal_wrong_reference",
            `Portal capture for ${role} does not match this job, docket, builder reference and URL.`,
            "Reject the capture and re-run against the exact typed source link.",
            [`portal-capture:${role}`],
          ),
        );
        manifest.items[captureItem] = itemBlocker;
        continue;
      }
      const captureFailure = captureBlocker(capture);
      if (captureFailure) {
        manifest.items[captureItem] = addBlocker(blockers, captureFailure);
      } else if (!screenshotBytes?.byteLength) {
        manifest.items[captureItem] = addBlocker(
          blockers,
          blocked(
            "portal_unreachable",
            `Portal ${role} returned a submitted/locked signal without the required screenshot.`,
            "Re-run the approved portal capture and retain the tied screenshot.",
            [`portal-capture:${role}`],
          ),
        );
      } else {
        const evidencePath = `EVIDENCE/portal_${role}.json`;
        manifest.items[captureItem] = ready(`file:${evidencePath}`);
        artifacts.push(
          await artifactFromText({
            role: `portal_${role}`,
            path: evidencePath,
            media_type: "application/json",
            text: canonicalSesJson(captureRecord),
          }),
        );
        if (screenshotBytes) {
          artifacts.push(
            await artifactFromBytes({
              role: `portal_${role}_screenshot`,
              path: `EVIDENCE/portal_${role}.png`,
              media_type: "image/png",
              bytes: screenshotBytes,
            }),
          );
        }
      }
    }
    if (row.required_portal_roles.length) {
      manifest.items.supporting_portal_links = blockers.some(
          (candidate) =>
            candidate.reason_code.startsWith("portal_") ||
            candidate.reason_code === "capability_portal_degraded",
        )
        ? blocked(
          "capture-failure",
          "One or more required portal links/captures are not ready.",
          "Resolve the typed portal blocker and re-run.",
          row.required_portal_roles.map((role) => `portal-role:${role}`),
        )
        : ready("file:EVIDENCE/portal_evidence.json");
    }
  });

  await measure("T5", async () => {
    if (!row || !swms) return;
    if (row.job_type === "physical_makesafe") {
      const acceptedBundle =
        input.sibling_bundle_evidence?.status === "accepted"
          ? input.sibling_bundle_evidence
          : null;
      const hasLocalPhysicalEvidence = !!input.cycle_facts.trade_report &&
        input.cycle_facts.photos.length > 0;
      if (!hasLocalPhysicalEvidence && acceptedBundle) {
        const bundleProof = {
          version: "ses-sibling-bundle-evidence/v1",
          claiming_job_id: input.identity.job_id,
          ...acceptedBundle,
        };
        artifacts.push(
          await artifactFromText({
            role: "sibling_bundle_evidence",
            path: "PROOF/sibling_bundle_evidence.json",
            media_type: "application/json",
            text: canonicalSesJson(bundleProof),
            metadata: bundleProof,
          }),
        );
        const bundledProof = deps.resolveBundledPhysicalReportProof
          ? await deps.resolveBundledPhysicalReportProof(input)
          : null;
        const resolved =
          bundledProof && validPhysicalReportProof(bundledProof) &&
            deps.renderBundledPhysicalReport
            ? await deps.renderBundledPhysicalReport(input, bundledProof)
            : null;
        const resolvedRawHash = resolved
          ? await rawArtifactSha256(resolved.bytes)
          : null;
        const resolvedContentHash = resolved
          ? await sesSha256Bytes(resolved.bytes)
          : null;
        if (
          !resolved ||
          !bundledProof ||
          !validPhysicalReportProof(bundledProof) ||
          resolvedRawHash !== bundledProof.expected_raw_sha256 ||
          resolvedContentHash !== bundledProof.source_artifact_content_hash ||
          (text(resolved.render_hash) &&
            `sha256:${text(resolved.render_hash).replace(/^sha256:/, "")}` !==
              resolvedRawHash)
        ) {
          persistenceRefused = true;
          const itemBlocker = addBlocker(
            blockers,
            blocked(
              "sibling_evidence_artifact_unrecoverable",
              `Bundle ${acceptedBundle.bundle_id} is valid, but sibling ${acceptedBundle.sibling.job_number}'s independently proved report artifact could not be recovered.`,
              "Restore the exact claimed sibling report document and its durable proof; do not substitute an unclaimed file.",
              [
                "canonical-input-envelope",
                "sibling-bundle-binding-ledger",
                "sibling-positive-scope-claim",
              ],
              [acceptedBundle.coverage.report_document_id],
              {
                bundle_id: acceptedBundle.bundle_id,
                sibling_job_id: acceptedBundle.sibling.job_id,
                sibling_job_number: acceptedBundle.sibling.job_number,
                report_document_id: acceptedBundle.coverage.report_document_id,
                source_revision_id: bundledProof?.source_revision_id || null,
                source_artifact_id: bundledProof?.source_artifact_id || null,
              },
            ),
          );
          manifest.items.physical_reporting_evidence = itemBlocker;
          manifest.items.supporting_report_pdf = itemBlocker;
        } else {
          reportFile = `ARTIFACTS/${resolved.file_name}`;
          artifacts.push(
            await artifactFromBytes({
              role: "supporting_report_pdf",
              path: reportFile,
              media_type: resolved.media_type,
              bytes: resolved.bytes,
              metadata: {
                ...(resolved.provenance || {}),
                render_hash: resolvedRawHash,
                evidence_source: "explicit_sibling_bundle",
                report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
                bundle_id: acceptedBundle.bundle_id,
                sibling_job_id: acceptedBundle.sibling.job_id,
                binding_revision_id:
                  acceptedBundle.claiming_binding.revision_id,
                report_document_id: acceptedBundle.coverage.report_document_id,
                source_kind: bundledProof.source_kind,
                source_identity: bundledProof.source_identity,
                source_revision_id: bundledProof.source_revision_id,
                source_artifact_id: bundledProof.source_artifact_id,
                source_artifact_content_hash:
                  bundledProof.source_artifact_content_hash,
                report_input_hash: bundledProof.report_input_hash || null,
                expected_raw_sha256: bundledProof.expected_raw_sha256,
                output_sha256: resolvedRawHash,
                output_content_hash: resolvedContentHash,
              },
            }),
          );
          manifest.items.supporting_report_pdf = ready(`file:${reportFile}`);
          manifest.items.physical_reporting_evidence = ready(
            "file:PROOF/sibling_bundle_evidence.json",
          );
          const resolvedPhotos = deps.resolveBundledPhotoArtifacts
            ? await deps.resolveBundledPhotoArtifacts(input)
            : [];
          const resolvedPhoto = resolvedPhotos.length === 1
            ? resolvedPhotos[0]
            : null;
          const expectedPhotoHash = acceptedBundle.coverage.photo.content_hash;
          if (
            !resolvedPhoto ||
            !/^sha256:[0-9a-f]{64}$/.test(expectedPhotoHash)
          ) {
            persistenceRefused = true;
            const itemBlocker = addBlocker(
              blockers,
              blocked(
                "sibling_evidence_photo_artifact_unrecoverable",
                `Bundle ${acceptedBundle.bundle_id} is valid, but its exact sibling photo artifact could not be recovered or validated.`,
                "Restore the exact hashed sibling photo artifact with positive scope coverage; do not substitute an email attachment claim.",
                [
                  "canonical-input-envelope",
                  "sibling-bundle-binding-ledger",
                  "sibling-positive-scope-claim",
                  "sibling-photo-artifact",
                ],
                [acceptedBundle.coverage.photo.media_id],
                {
                  bundle_id: acceptedBundle.bundle_id,
                  sibling_job_id: acceptedBundle.sibling.job_id,
                  media_id: acceptedBundle.coverage.photo.media_id,
                  content_hash: expectedPhotoHash,
                },
              ),
            );
            manifest.items.physical_reporting_evidence = itemBlocker;
            manifest.items.supporting_report_pdf = itemBlocker;
          } else {
            const photoFile = `ARTIFACTS/photos/${resolvedPhoto.file_name}`;
            const photoArtifact = await artifactFromBytes({
              role: "sibling_photo_evidence",
              path: photoFile,
              media_type: resolvedPhoto.media_type,
              bytes: resolvedPhoto.bytes,
              metadata: {
                evidence_source: "explicit_sibling_bundle",
                bundle_id: acceptedBundle.bundle_id,
                sibling_job_id: acceptedBundle.sibling.job_id,
                media_id: acceptedBundle.coverage.photo.media_id,
                claimed_content_hash: expectedPhotoHash,
                scope_phrase: acceptedBundle.coverage.photo.scope_phrase,
              },
            });
            if (
              await rawArtifactSha256(resolvedPhoto.bytes) !== expectedPhotoHash
            ) {
              persistenceRefused = true;
              const itemBlocker = addBlocker(
                blockers,
                blocked(
                  "sibling_evidence_photo_artifact_hash_mismatch",
                  "The recovered sibling photo bytes do not match the durable claimed content hash.",
                  "Recover the exact immutable sibling photo artifact and re-run.",
                  ["sibling-photo-artifact"],
                  [acceptedBundle.coverage.photo.media_id],
                  {
                    expected_content_hash: expectedPhotoHash,
                    actual_content_hash: await rawArtifactSha256(
                      resolvedPhoto.bytes,
                    ),
                  },
                ),
              );
              manifest.items.physical_reporting_evidence = itemBlocker;
              manifest.items.supporting_report_pdf = itemBlocker;
            } else {
              photoFiles.push(photoFile);
              artifacts.push(photoArtifact);
              artifacts.push(
                await artifactFromText({
                  role: "photo_selection",
                  path: "ARTIFACTS/PHOTO_SELECTION.md",
                  media_type: "text/markdown",
                  text: [
                    "Sibling photo evidence claim",
                    `Email: ${acceptedBundle.coverage.photo.email_post_id}`,
                    `Content SHA-256: ${acceptedBundle.coverage.photo.content_sha256}`,
                    `Media ID: ${acceptedBundle.coverage.photo.media_id}`,
                    `Content hash: ${expectedPhotoHash}`,
                    `Scope: ${acceptedBundle.coverage.photo.scope_phrase}`,
                  ].join("\n"),
                }),
              );
            }
          }
        }
      } else if (!hasLocalPhysicalEvidence) {
        const itemBlocker = addBlocker(
          blockers,
          blocked(
            "trade_evidence_missing",
            "Physical make-safe requires a current-cycle trade report and complete photo story.",
            "Submit/bind current-cycle trade evidence and re-run.",
          ),
        );
        manifest.items.physical_reporting_evidence = itemBlocker;
        manifest.items.supporting_report_pdf = itemBlocker;
      } else {
        let resolvedPhotos: SesPhotoArtifact[] = [];
        let photosComplete = false;
        let reportProof: SesPhysicalReportProof | null = null;
        if (!text(input.source.builder_reference)) {
          persistenceRefused = true;
          const itemBlocker = blockers.find(
            (candidate) =>
              candidate.reason_code === "spine_missing_source" &&
              candidate.reason ===
                "Builder reference is absent from the canonical source instruction.",
          ) ||
            addBlocker(
              blockers,
              blocked(
                "spine_missing_source",
                "Builder reference is absent from the canonical source instruction.",
                "Recover the WO/PO/external reference from the canonical source case.",
              ),
            );
          manifest.items.physical_reporting_evidence = itemBlocker;
          manifest.items.supporting_report_pdf = itemBlocker;
        } else if (!deps.resolvePhysicalReportProof) {
          persistenceRefused = true;
          const itemBlocker = addBlocker(
            blockers,
            blocked(
              "curated_source_missing",
              "No independent durable curated report source can be proved.",
              "Bind an approved durable curation revision or exact previously committed PDF artifact with its expected raw SHA-256, then re-run.",
            ),
          );
          manifest.items.physical_reporting_evidence = itemBlocker;
          manifest.items.supporting_report_pdf = itemBlocker;
        } else {
          reportProof = await deps.resolvePhysicalReportProof(input);
          const expectedProof = request.expected_physical_report_proof;
          const proofDrifted = expectedProof !== undefined &&
            !samePhysicalReportProof(reportProof, expectedProof);
          if (!validPhysicalReportProof(reportProof) || proofDrifted) {
            persistenceRefused = true;
            reportProof = null;
            const refusal = {
              code: proofDrifted
                ? "curated_source_drift"
                : "curated_source_missing",
              fact: proofDrifted
                ? "The currently selected committed report source no longer matches the reviewed dry-run proof."
                : "Raw trade-report fields and self-referential curated labels are not independent semantic authority.",
              recovery_action:
                "Bind an approved durable curation revision or exact previously committed PDF artifact with its expected raw SHA-256.",
              ...(expectedProof
                ? { expected_physical_report_proof: expectedProof }
                : {}),
            };
            const itemBlocker = addBlocker(
              blockers,
              blocked(
                refusal.code,
                proofDrifted
                  ? "The committed curated report source changed after dry-run review."
                  : "No independent durable curated report source can be proved.",
                refusal.recovery_action,
                ["current-cycle-curated-source"],
                ["job_service_reports", "self-referential-report-document"],
              ),
            );
            artifacts.push(
              await artifactFromText({
                role: "curated_source_refusal",
                path: "PROOF/curated_source_refusal.json",
                media_type: "application/json",
                text: canonicalSesJson(refusal),
                metadata: refusal,
              }),
            );
            manifest.items.physical_reporting_evidence = itemBlocker;
            manifest.items.supporting_report_pdf = itemBlocker;
          } else if (!request.dry_run && !deps.renderPhysicalReport) {
            persistenceRefused = true;
            const itemBlocker = addBlocker(
              blockers,
              blocked(
                "curated_report_unrecoverable",
                "The proved curated report bytes cannot be recovered.",
                "Restore read access to the exact proved PDF artifact and re-run.",
              ),
            );
            manifest.items.physical_reporting_evidence = itemBlocker;
            manifest.items.supporting_report_pdf = itemBlocker;
          }
        }

        const expectedPhotos = input.cycle_facts.photos
          .slice()
          .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
        if (request.dry_run && !deps.resolvePhotoProofs) {
          degradedCapabilities.push("photo_proof_recovery");
          manifest.items.physical_reporting_evidence = addBlocker(
            blockers,
            blocked(
              "trade_evidence_missing",
              "Current-cycle photo proof recovery capability is unavailable.",
              "Resume with the U2/U3 cycle-scoped photo proof adapter.",
            ),
          );
        } else if (!request.dry_run && !deps.resolvePhotoArtifacts) {
          degradedCapabilities.push("photo_artifact_recovery");
          manifest.items.physical_reporting_evidence = addBlocker(
            blockers,
            blocked(
              "trade_evidence_missing",
              "Current-cycle photo artifact recovery capability is unavailable.",
              "Resume with the U2/U3 cycle-scoped photo storage adapter.",
            ),
          );
        } else if (request.dry_run) {
          const resolvedProofs = await deps.resolvePhotoProofs!(input);
          const matchedIndexes = new Set<number>();
          photosComplete = true;
          for (const [index, expected] of expectedPhotos.entries()) {
            const matches = resolvedProofs
              .map((proof, resolvedIndex) => ({
                proof,
                resolvedIndex,
              }))
              .filter(
                ({ proof }) =>
                  proof.photo_id === expected.id &&
                  proof.source_pointer === expected.path_or_key,
              );
            const resolved = matches.length === 1 ? matches[0] : null;
            if (
              !resolved ||
              matchedIndexes.has(resolved.resolvedIndex) ||
              !text(resolved.proof.file_name) ||
              resolved.proof.file_name.includes("/") ||
              resolved.proof.file_name.includes("..") ||
              !/^sha256:[0-9a-f]{64}$/.test(resolved.proof.content_hash) ||
              !Number.isSafeInteger(resolved.proof.size_bytes) ||
              resolved.proof.size_bytes <= 0
            ) {
              photosComplete = false;
              addBlocker(
                blockers,
                blocked(
                  "trade_evidence_missing",
                  `Photo ${expected.id} did not resolve to one safe, non-empty current-cycle proof.`,
                  "Recover the exact cycle-scoped photo metadata and content hash, then re-run.",
                  ["canonical-input-envelope", "cycle-photo-proof"],
                  [expected.path_or_key],
                ),
              );
              continue;
            }
            matchedIndexes.add(resolved.resolvedIndex);
            const storedPath = `ARTIFACTS/photos/${
              String(index + 1).padStart(
                3,
                "0",
              )
            }-${resolved.proof.file_name}`;
            photoFiles.push(storedPath);
            const proof = {
              photo_id: expected.id,
              source_pointer: expected.path_or_key,
              order: expected.order,
              caption: expected.caption || null,
              content_hash: resolved.proof.content_hash,
              size_bytes: resolved.proof.size_bytes,
              media_type: resolved.proof.media_type,
              intended_path: storedPath,
            };
            artifacts.push(
              await artifactFromText({
                role: "completion_photo_proof",
                path: `PROOF/photos/${
                  String(index + 1).padStart(
                    3,
                    "0",
                  )
                }.json`,
                media_type: "application/json",
                text: canonicalSesJson(proof),
                metadata: proof,
              }),
            );
          }
          if (
            matchedIndexes.size !== resolvedProofs.length ||
            photoFiles.length !== expectedPhotos.length
          ) {
            photosComplete = false;
            addBlocker(
              blockers,
              blocked(
                "trade_evidence_missing",
                "Resolved photo proofs do not exactly match the current-cycle photo set.",
                "Remove foreign/duplicate photos and recover a hash for every expected current-cycle photo.",
                ["canonical-input-envelope", "cycle-photo-proof"],
              ),
            );
          }
        } else {
          resolvedPhotos = await deps.resolvePhotoArtifacts!(input);
          const matchedIndexes = new Set<number>();
          photosComplete = true;
          for (const [index, expected] of expectedPhotos.entries()) {
            const matches = resolvedPhotos
              .map((photo, resolvedIndex) => ({
                photo,
                resolvedIndex,
              }))
              .filter(
                ({ photo }) =>
                  photo.photo_id === expected.id &&
                  photo.source_pointer === expected.path_or_key,
              );
            const resolved = matches.length === 1 ? matches[0] : null;
            if (
              !resolved ||
              matchedIndexes.has(resolved.resolvedIndex) ||
              !text(resolved.photo.file_name) ||
              resolved.photo.file_name.includes("/") ||
              resolved.photo.file_name.includes("..") ||
              !resolved.photo.bytes.byteLength
            ) {
              photosComplete = false;
              addBlocker(
                blockers,
                blocked(
                  "trade_evidence_missing",
                  `Photo ${expected.id} did not resolve to one safe, non-empty current-cycle artifact.`,
                  "Recover the exact cycle-scoped photo bytes and re-run.",
                  ["canonical-input-envelope", "cycle-photo-storage"],
                  [expected.path_or_key],
                ),
              );
              continue;
            }
            matchedIndexes.add(resolved.resolvedIndex);
            const storedPath = `ARTIFACTS/photos/${
              String(index + 1).padStart(
                3,
                "0",
              )
            }-${resolved.photo.file_name}`;
            photoFiles.push(storedPath);
            artifacts.push(
              await artifactFromBytes({
                role: "completion_photo",
                path: storedPath,
                media_type: resolved.photo.media_type,
                bytes: resolved.photo.bytes,
                metadata: {
                  photo_id: expected.id,
                  source_pointer: expected.path_or_key,
                  order: expected.order,
                  caption: expected.caption || null,
                },
              }),
            );
          }
          if (
            matchedIndexes.size !== resolvedPhotos.length ||
            photoFiles.length !== expectedPhotos.length
          ) {
            photosComplete = false;
            addBlocker(
              blockers,
              blocked(
                "trade_evidence_missing",
                "Resolved photo artifacts do not exactly match the current-cycle photo set.",
                "Remove foreign/duplicate photos and recover every expected current-cycle photo.",
                ["canonical-input-envelope", "cycle-photo-storage"],
              ),
            );
          }
          if (
            photosComplete &&
            manifest.items.supporting_report_pdf.state === "ready"
          ) {
            manifest.items.physical_reporting_evidence = ready(
              "file:ARTIFACTS/PHOTO_SELECTION.md",
            );
          }
        }
        if (
          request.dry_run &&
          text(input.source.builder_reference) &&
          reportProof &&
          photosComplete
        ) {
          reportFile = `ARTIFACTS/${
            makesafeReportFileName(
              input.source.builder_reference,
              input.source.site_address || "Address not recorded",
            )
          }`;
          const plan = {
            mode: "curated_report_artifact_recovery",
            intended_path: reportFile,
            photo_count: photoFiles.length,
            photo_proof_paths: artifacts
              .filter((artifact) => artifact.role === "completion_photo_proof")
              .map((artifact) => artifact.path),
            selected_source: reportProof,
          };
          artifacts.push(
            await artifactFromText({
              role: "supporting_report_plan",
              path: "PROOF/supporting_report_plan.json",
              media_type: "application/json",
              text: canonicalSesJson(plan),
              metadata: plan,
            }),
          );
          manifest.items.supporting_report_pdf = ready(
            `proof:PROOF/supporting_report_plan.json#source=${reportProof.source_identity}#sha256=${
              reportProof.expected_raw_sha256.slice(7)
            }`,
          );
          manifest.items.physical_reporting_evidence = ready(
            "file:ARTIFACTS/PHOTO_SELECTION.md",
          );
        } else if (
          !request.dry_run &&
          text(input.source.builder_reference) &&
          deps.renderPhysicalReport &&
          reportProof &&
          photosComplete
        ) {
          const rendered = await deps.renderPhysicalReport(
            input,
            resolvedPhotos,
            reportProof,
          );
          const outputSha256 = await rawArtifactSha256(rendered.bytes);
          const outputContentHash = await sesSha256Bytes(rendered.bytes);
          const claimedRenderHash = text(rendered.render_hash).replace(
            /^sha256:/,
            "",
          );
          if (
            outputSha256 !== reportProof.expected_raw_sha256 ||
            outputContentHash !== reportProof.source_artifact_content_hash ||
            (claimedRenderHash &&
              `sha256:${claimedRenderHash}` !== outputSha256)
          ) {
            persistenceRefused = true;
            const refusal = {
              code: "curated_report_hash_mismatch",
              source_identity: reportProof.source_identity,
              expected_raw_sha256: reportProof.expected_raw_sha256,
              source_artifact_content_hash:
                reportProof.source_artifact_content_hash,
              recovered_raw_sha256: outputSha256,
              recovered_content_hash: outputContentHash,
            };
            const itemBlocker = addBlocker(
              blockers,
              blocked(
                refusal.code,
                "Recovered curated report bytes do not match the proved raw SHA-256.",
                "Recover the exact selected committed source bytes or create a new independently approved curation revision.",
                ["curated-report-byte-recovery"],
                [reportProof.source_identity],
                refusal,
              ),
            );
            artifacts.push(
              await artifactFromText({
                role: "curated_source_refusal",
                path: "PROOF/curated_source_refusal.json",
                media_type: "application/json",
                text: canonicalSesJson(refusal),
                metadata: refusal,
              }),
            );
            manifest.items.supporting_report_pdf = itemBlocker;
            manifest.items.physical_reporting_evidence = itemBlocker;
          } else {
            reportFile = `ARTIFACTS/${rendered.file_name}`;
            artifacts.push(
              await artifactFromBytes({
                role: "supporting_report_pdf",
                path: reportFile,
                media_type: rendered.media_type,
                bytes: rendered.bytes,
                metadata: {
                  ...(rendered.provenance || {}),
                  source_kind: reportProof.source_kind,
                  source_identity: reportProof.source_identity,
                  source_document_id: reportProof.source_document_id,
                  source_revision_id: reportProof.source_revision_id,
                  source_artifact_id: reportProof.source_artifact_id,
                  source_artifact_content_hash:
                    reportProof.source_artifact_content_hash,
                  report_input_hash: reportProof.report_input_hash || null,
                  expected_raw_sha256: reportProof.expected_raw_sha256,
                  output_sha256: outputSha256,
                  output_content_hash: outputContentHash,
                  render_hash: outputSha256.slice("sha256:".length),
                },
              }),
            );
            manifest.items.supporting_report_pdf = ready(`file:${reportFile}`);
            manifest.items.physical_reporting_evidence = ready(
              "file:ARTIFACTS/PHOTO_SELECTION.md",
            );
          }
        }
      }
    } else if (
      row.family === "own_template_roof" &&
      input.classification.delivery_render_route ===
        "secureworks_own_letterhead"
    ) {
      if (!input.cycle_facts.roof_report_fields || !deps.renderOwnRoofReport) {
        const itemBlocker = addBlocker(
          blockers,
          blocked(
            "trade_evidence_missing",
            "Own-template roof requires submitted trade-authored fields and the existing roof renderer.",
            "Submit the current-cycle roof template and resume its deterministic renderer.",
          ),
        );
        manifest.items.supporting_report_pdf = itemBlocker;
      } else {
        const rendered = await deps.renderOwnRoofReport(input);
        reportFile = `ARTIFACTS/${rendered.file_name}`;
        artifacts.push(
          await artifactFromBytes({
            role: "supporting_report_pdf",
            path: reportFile,
            media_type: rendered.media_type,
            bytes: rendered.bytes,
            metadata: { render_hash: rendered.render_hash || null },
          }),
        );
        manifest.items.supporting_report_pdf = ready(`file:${reportFile}`);
      }
    }
    if (swms.required) {
      const planned = buildSesSwmsGenerationPlan(input);
      if (!planned.ok) {
        const itemBlocker = addBlocker(
          blockers,
          blocked(
            planned.reason_code,
            planned.reason,
            planned.recovery_action,
            [
              "canonical-input-envelope",
              "sealed-swms-template-catalogue",
            ],
            [],
            planned.facts,
          ),
        );
        manifest.items.swms_artifact = itemBlocker;
      } else if (request.dry_run) {
        swmsFile = `ARTIFACTS/${planned.plan.output_file_name}`;
        const planFile = "ARTIFACTS/SWMS_GENERATION_PLAN.json";
        artifacts.push(
          await artifactFromText({
            role: "swms_generation_plan",
            path: planFile,
            media_type: "application/json",
            text: canonicalSesJson(planned.plan),
            metadata: {
              generation_plan_version: planned.plan.contract_version,
              template_version: planned.plan.template_version,
              template_kind: planned.plan.template.kind,
              template_source_sha256: planned.plan.template.source_sha256,
              source_instruction_id:
                planned.plan.provenance.source_instruction_id,
              trade_report_id: planned.plan.provenance.trade_report_id,
              evidence_kind: planned.plan.provenance.evidence_kind,
              evidence_job_id: planned.plan.provenance.evidence_job_id,
              evidence_job_number: planned.plan.provenance.evidence_job_number,
            },
          }),
        );
        manifest.items.swms_artifact = ready(
          `planned:${swmsFile}#${planned.plan.template_version}/${planned.plan.template.kind}`,
        );
      } else {
        const rendered = deps.renderSwmsArtifact
          ? await deps.renderSwmsArtifact(planned.plan)
          : null;
        if (!rendered) {
          const itemBlocker = addBlocker(
            blockers,
            blocked(
              "swms_generation_capability_unavailable",
              "The deterministic SWMS renderer is unavailable.",
              "Restore the ops-api SWMS renderer and re-run U4; staff do not need to attach a SWMS.",
              [
                "sealed-swms-template-catalogue",
                "ops-api-runtime-capabilities",
              ],
            ),
          );
          manifest.items.swms_artifact = itemBlocker;
        } else {
          swmsFile = `ARTIFACTS/${rendered.file_name}`;
          artifacts.push(
            await artifactFromBytes({
              role: "swms_artifact",
              path: swmsFile,
              media_type: rendered.media_type,
              bytes: rendered.bytes,
              metadata: {
                render_hash: rendered.render_hash || null,
                provenance: rendered.provenance || {},
              },
            }),
          );
          manifest.items.swms_artifact = ready(
            `generated:${swmsFile}#${planned.plan.template_version}/${planned.plan.template.kind}`,
          );
        }
      }
    }
    if (row.job_type === "physical_makesafe") {
      artifacts.push(
        await artifactFromText({
          role: "photo_selection",
          path: "ARTIFACTS/PHOTO_SELECTION.md",
          media_type: "text/markdown",
          text: input.cycle_facts.photos
            .slice()
            .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
            .map(
              (photo, index) =>
                `${index + 1}. ${
                  photoFiles[index] || `MISSING:${photo.path_or_key}`
                } - ${photo.caption || "Not provided"}`,
            )
            .join("\n"),
        }),
      );
    }
  });

  const priced = row
    ? await measure(
      "T6",
      () =>
        Promise.resolve(
          localInvoiceProposal(
            input,
            row,
            materialsChargeDecision,
            invoicedMaterialsEvidence,
            releasedCycleEvidence,
            suppliedMaterialsChargeNow,
          ),
        ),
    )
    : { proposal: null, blocker: null };
  if (!row) stagesMs.T6 = 0;
  if (priced.blocker) {
    // A decision made while the card is blocked for some OTHER pricing reason
    // has no proposal to ride on. Stamping it here is what keeps the standing
    // decision durable on every revision, so the next prepare inherits this
    // answer rather than an older one.
    //
    // A decision the materials guard REFUSED is not such a decision and is
    // never stamped. Persisting it would make the refusal survive exactly one
    // prepare: the next one, sent with no body key, would inherit the rejected
    // figure as a standing answer, terminal would stand aside because a
    // decision appears to exist, and a charge line would land on a cycle that
    // has already shipped and been billed.
    if (
      materialsChargeDecision && !priced.proposal &&
      !priced.materials_charge_refused
    ) {
      priced.blocker.facts = {
        ...(priced.blocker.facts || {}),
        [MATERIALS_CHARGE_DECISION_FACT]: materialsChargeDecisionMarker(
          materialsChargeDecision,
          recordedMaterialsUsed(recordedMaterialsFact(input)),
        ),
      };
    }
    addBlocker(blockers, priced.blocker);
  }
  if (priced.proposal) {
    artifacts.push(
      await artifactFromText({
        role: "invoice_proposal",
        path: "ARTIFACTS/invoice_proposal.json",
        media_type: "application/json",
        text: canonicalSesJson(priced.proposal),
      }),
    );
  }

  stagesMs.T7 = 0;
  // Photo-mail volume guard: refuse a pack that cannot fit one Graph message
  // BEFORE the card claims docs-ready. Never cull/downscale/re-encode photos.
  if (row && photoFiles.length > 0) {
    const photoArtifacts = artifacts.filter(
      (artifact) => artifact.role === "completion_photo",
    );
    if (photoArtifacts.length > 0) {
      const transport = resolveSesMailTransportForPrepare({
        builder_key: row.builder_key,
        family: row.family,
        route_kind: "photo",
      });
      const volumeVerdict = evaluateSesPhotoMailVolume(
        photoArtifacts.map((artifact) => ({
          name: artifact.path.split("/").pop() || artifact.path,
          size_bytes: artifact.size_bytes,
        })),
        transport,
      );
      if (!volumeVerdict.ok) {
        addBlocker(blockers, sesPhotoMailVolumeBlocker(volumeVerdict));
      }
    }
  }
  const drafts = row
    ? blockers.length === 0
      ? buildEmailDrafts(
        input,
        row,
        reportFile,
        swmsFile,
        photoFiles,
        priced.proposal,
      )
      : {}
    : {};
  if (drafts.REPORT_EMAIL_DRAFT) {
    manifest.items.draft_builder_report_email = ready(
      "file:DRAFTS/REPORT_EMAIL_DRAFT.txt",
    );
  }
  // AJS/AJBR (Captain 2026-08-04) emit a combined REPORT_EMAIL_DRAFT that is
  // the report+invoice route — there is no separate INVOICE_EMAIL_DRAFT key.
  // Mark the invoice-bundle obligation from that combined draft so pre-Xero
  // readiness does not invent a third email the route deliberately dropped.
  if (drafts.INVOICE_EMAIL_DRAFT) {
    manifest.items.draft_invoice_bundle_email = ready(
      "file:DRAFTS/INVOICE_EMAIL_DRAFT.txt",
    );
  } else if (
    row &&
    isAjsBuilderKey(row.builder_key) &&
    drafts.REPORT_EMAIL_DRAFT
  ) {
    manifest.items.draft_invoice_bundle_email = ready(
      "file:DRAFTS/REPORT_EMAIL_DRAFT.txt",
    );
  }
  if (drafts.PHOTO_EMAIL_DRAFT) {
    manifest.items.draft_photo_evidence_email = ready(
      "file:DRAFTS/PHOTO_EMAIL_DRAFT.txt",
    );
  }
  if (Object.keys(drafts).length) {
    manifest.items.email_drafts_presented = ready(
      "review:review.html#email-drafts",
    );
  } else if (blockers.length) {
    manifest.items.email_drafts_presented = blockers[0];
  }
  stagesMs.T8 = 0;
  for (const [name, body] of Object.entries(drafts)) {
    artifacts.push(
      await artifactFromText({
        role: name.toLowerCase(),
        path: `DRAFTS/${name}.txt`,
        media_type: "text/plain",
        text: body,
      }),
    );
  }
  if (portalEvidence.length) {
    artifacts.push(
      await artifactFromText({
        role: "portal_evidence",
        path: "EVIDENCE/portal_evidence.json",
        media_type: "application/json",
        text: canonicalSesJson(portalEvidence),
      }),
    );
  }

  const reviewSpec: Record<string, unknown> = {
    version: SES_DOCKET_REVIEW_SPEC_VERSION,
    property_id: input.identity.property_id,
    address: [input.source.site_address, input.source.site_suburb]
      .filter(Boolean)
      .join(", "),
    cards: [
      {
        job_id: input.identity.job_id,
        family: row?.family || input.classification.family,
        builder_reference: input.source.builder_reference,
        trade_report: reviewTradeReport(input),
        portal_proof: portalEvidence,
        artifact_paths: artifacts.map((artifact) => artifact.path).sort(),
        blocker_codes: blockers.map((item) => item.reason_code),
        waiting_on: blockers.map((item) => item.reason),
      },
    ],
  };
  const releasePayload: Record<string, unknown> = {
    version: "ses-inert-release-proposal/v1",
    job_id: input.identity.job_id,
    invoice_create_approved: false,
    client_send_approved: false,
    send_email: false,
    send_sms: false,
    create_invoice: false,
    authorise_invoice: false,
    close_job: false,
    portal_evidence: portalEvidence,
  };
  const review = reviewHtml(
    input,
    row?.family || input.classification.family,
    blockers,
    drafts,
  );
  artifacts.push(
    await artifactFromText({
      role: "review_spec",
      path: "review_spec.json",
      media_type: "application/json",
      text: canonicalSesJson(reviewSpec),
    }),
    await artifactFromText({
      role: "review_html",
      path: "review.html",
      media_type: "text/html",
      text: review,
    }),
    await artifactFromText({
      role: "release_payload",
      path: "release_payload.json",
      media_type: "application/json",
      text: canonicalSesJson(releasePayload),
    }),
  );
  if (row) {
    artifacts.push(
      await artifactFromText({
        role: "case_story",
        path: "case_story.json",
        media_type: "application/json",
        text: canonicalSesJson({
          version: "secureworks.makesafe.case-story/assembler-spine-v1",
          source_instruction_id: input.identity.source_instruction_id,
          lineage_id: input.identity.lineage_id,
          case_id: input.identity.case_id,
          deliverables: input.source.deliverables,
          lineage: input.classification.lineage_kind,
          hrcw: input.hrcw,
          searches_attempted: ["canonical-input-envelope"],
        }),
      }),
    );
  }
  stagesMs.T9 = 0;

  const revisionIdentityArgs = {
    assembler_version: request.assembler_version,
    family_matrix_version: SES_FAMILY_MATRIX_VERSION,
    idempotency_key: request.idempotency_key,
    input_content_hash: inputContentHash,
  };
  const revisionIdentity = await sesDocketRevisionIdentity(
    revisionIdentityArgs,
  );
  const legacyRevisionIdentity = await sesDocketRevisionIdentity({
    ...revisionIdentityArgs,
    output_hash_version: SES_DOCKET_LEGACY_OUTPUT_HASH_VERSION,
  });
  const docketRevisionId = revisionIdentity.revision_id;
  const stableOutput = {
    manifest,
    invoice_proposal: priced.proposal,
    email_drafts: drafts,
    portal_evidence: portalEvidence,
    review_spec: reviewSpec,
    release_payload: releasePayload,
    artifact_hashes: artifacts
      .map((artifact) => ({
        role: artifact.role,
        path: artifact.path,
        content_hash: artifact.content_hash,
        size_bytes: artifact.size_bytes,
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    blockers,
  };
  const outputContentHash = await sesSha256(
    stableOutput,
    SES_DOCKET_OUTPUT_HASH_DOMAIN,
  );
  const preXeroDocsReady = validatePreXero(
    manifest,
    priced.proposal,
    artifacts,
    blockers,
  );
  const envelope: SesDocketEnvelopeV3 = {
    version: SES_DOCKET_ENVELOPE_VERSION,
    v2: manifest,
    spine: {
      source_instruction_id: input.identity.source_instruction_id,
      lineage_id: input.identity.lineage_id,
      job_id: input.identity.job_id,
      card_id: input.identity.card_id,
      property_id: input.identity.property_id,
      attendance_cycle_ids: sortedUnique(input.attendance.attendance_cycle_ids),
      current_attendance_cycle_id: input.attendance.current_attendance_cycle_id,
      readiness_revision: input.readiness.readiness_revision,
      docket_revision_id: docketRevisionId,
    },
    pre_xero_docs_ready: preXeroDocsReady,
    local_invoice_proposal: priced.proposal
      ? { state: "ready", evidence: "file:ARTIFACTS/invoice_proposal.json" }
      : {
        state: "blocked",
        evidence: `blocker:${
          priced.blocker?.reason_code ||
          applicabilityBlocker?.reason_code ||
          "pricing_evidence_missing"
        }`,
      },
    invoice_create_approved: false,
    client_send_approved: false,
    family_matrix_version: SES_FAMILY_MATRIX_VERSION,
    assembler_version: SES_ASSEMBLER_VERSION,
    input_content_hash: inputContentHash,
    output_content_hash: outputContentHash,
  };
  artifacts.push(
    await artifactFromText({
      role: "docket_manifest",
      path: "docket_manifest.json",
      media_type: "application/json",
      text: canonicalSesJson(manifest),
    }),
    await artifactFromText({
      role: "assembler_envelope",
      path: "ASSEMBLER_ENVELOPE.json",
      media_type: "application/json",
      text: canonicalSesJson(envelope),
    }),
    await artifactFromText({
      role: "capability",
      path: "CAPABILITY.json",
      media_type: "application/json",
      text: canonicalSesJson({
        recipe_selection: row ? "sealed" : "blocked",
        delivery_render_route: input.classification.delivery_render_route,
        delivery_render_route_reason_code:
          input.classification.delivery_render_route_reason_code,
        delivery_render_route_reason:
          input.classification.delivery_render_route_reason,
        portal_capture: !row
          ? "not_evaluated"
          : row.required_portal_roles.length
          ? deps.capturePortal ? "available" : "degraded"
          : "not_required",
        source_attachment_recovery: !row
          ? "not_evaluated"
          : deps.resolveSourceArtifacts
          ? "available"
          : "unavailable",
        photo_artifact_recovery: !row
          ? "not_evaluated"
          : row.job_type === "physical_makesafe"
          ? request.dry_run
            ? deps.resolvePhotoProofs ? "proof_only" : "unavailable"
            : deps.resolvePhotoArtifacts
            ? "available"
            : "unavailable"
          : "not_required",
        physical_renderer: !row
          ? "not_evaluated"
          : request.dry_run && row.job_type === "physical_makesafe"
          ? deps.resolvePhysicalReportProof
            ? "proved_independent_curated_source"
            : "unavailable"
          : deps.resolvePhysicalReportProof && deps.renderPhysicalReport
          ? "independent_curated_artifact_recovery"
          : "unavailable",
        own_roof_renderer: !row
          ? "not_evaluated"
          : deps.renderOwnRoofReport
          ? "available"
          : "unavailable",
        swms_provider: !row
          ? "not_evaluated"
          : !swms?.required
          ? "not_required"
          : deps.renderSwmsArtifact
          ? "generated_from_work_order_and_trade_report"
          : "unavailable",
        xero_mutation: "structurally_absent",
        send: "structurally_absent",
      }),
    }),
  );
  stagesMs.T10 = 0;

  const baseRevision: Omit<
    SesPreparedRevision,
    "timing" | "persisted" | "artifacts"
  > = {
    state: preXeroDocsReady ? "ready" : "blocked",
    docket_revision_id: docketRevisionId,
    input_content_hash: inputContentHash,
    output_content_hash: outputContentHash,
    envelope,
    blockers,
    portal_evidence: portalEvidence,
    invoice_proposal: priced.proposal,
    email_drafts: drafts,
    review_spec: reviewSpec,
    release_payload: releasePayload,
  };
  let persisted = false;
  let committedAt = now().toISOString();
  if (!request.dry_run) {
    if (
      deps.persist && !persistenceRefused &&
      (!request.require_ready_for_persistence || baseRevision.state === "ready")
    ) {
      const persistedResult = await measure("T11", () =>
        deps.persist!({
          revision: baseRevision,
          artifacts,
          idempotency_key: revisionIdentity.idempotency_key,
          legacy_identity: legacyRevisionIdentity,
          assembler_version: request.assembler_version,
          family_matrix_version: SES_FAMILY_MATRIX_VERSION,
          accepted_at: acceptedAt.toISOString(),
          stage_durations_ms: stagesMs,
        }));
      committedAt = persistedResult.committed_at;
      persisted = true;
    } else {
      stagesMs.T11 = 0;
    }
  } else {
    stagesMs.T11 = 0;
  }
  stagesMs.T12 = 0;
  const finishedAt = now();
  const durationMs = Math.max(0, finishedAt.getTime() - acceptedAt.getTime());
  const timing = {
    job_id: input.identity.job_id,
    accepted_at: acceptedAt.toISOString(),
    committed_at: committedAt,
    duration_ms: durationMs,
    stages_ms: stagesMs,
    retries: {},
    degraded_capabilities: degradedCapabilities,
    within_five_minutes: durationMs <= SES_FIVE_MINUTES_MS,
  };
  if (!timing.within_five_minutes) {
    console.error("ses_docket_revision_sla_breach", timing);
  }
  artifacts.push(
    await artifactFromText({
      role: "timing",
      path: "TIMING.json",
      media_type: "application/json",
      text: canonicalSesJson(timing),
    }),
  );
  const hashLines = artifacts
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((artifact) => `${artifact.content_hash.slice(7)}  ${artifact.path}`)
    .join("\n");
  artifacts.push(
    await artifactFromText({
      role: "hashes",
      path: "hashes.sha256",
      media_type: "text/plain",
      text: `${hashLines}\n`,
    }),
  );
  return {
    ...baseRevision,
    state: envelope.pre_xero_docs_ready && !blockers.length
      ? "ready"
      : "blocked",
    artifacts,
    timing,
    persisted,
  };
}

async function prepareSesDocketRevision(
  request: SesPrepareRequest,
  deps: SesPrepareDependencies,
): Promise<SesPrepareResponse> {
  validateRequest(request);
  let selections: Array<
    | { mode: "job_id"; job_id: string }
    | {
      mode: "job_number";
      job_number: string;
    }
  >;
  if (request.selection.mode === "board_batch") {
    if (!deps.listBoardJobs) {
      throw new TypeError(
        "board_batch requires the canonical U2 queue adapter",
      );
    }
    selections = await deps.listBoardJobs(request.selection.limit as number);
  } else if (request.selection.mode === "job_id") {
    selections = [
      {
        mode: "job_id",
        job_id: request.selection.job_id as string,
      },
    ];
  } else {
    selections = [
      {
        mode: "job_number",
        job_number: request.selection.job_number as string,
      },
    ];
  }
  const results = await Promise.all(
    selections.map((selection, index) =>
      prepareOne(
        {
          ...request,
          selection,
          idempotency_key: selections.length > 1
            ? `${request.idempotency_key}:job:${index}`
            : request.idempotency_key,
        },
        selection,
        deps,
      )
    ),
  );
  return {
    action: "prepare_ses_docket_revision",
    assembler_version: SES_ASSEMBLER_VERSION,
    dry_run: request.dry_run,
    results,
    timing_summary: responseSummary(results),
  };
}

export const prepare_ses_docket_revision = prepareSesDocketRevision;
