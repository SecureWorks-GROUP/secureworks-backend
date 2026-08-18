import {
  type SesAssemblerInputV1,
  type SesSha256,
  sesSha256Bytes,
} from "./ses_docket_envelope.ts";
import {
  resolveSesFamilyMatrixRow,
  type SesFamilyMatrixRow,
} from "./ses_family_matrix.ts";
import {
  type SesRenderResult,
  sesSwmsDecision,
} from "./ses_prepare_docket_revision.ts";
import {
  buildSesSwmsGenerationPlan,
  type SesSwmsGenerationPlan,
  type SesSwmsGenerationPlanResult,
} from "./ses_swms_template.ts";
import { renderSesSwmsPdf } from "./ses_swms_render.ts";

export const SES_SWMS_ATTACH_ACTION = "generate_attach_makesafe_swms";
export const SES_SWMS_ATTACH_PACK_KIND = "main";

export class SesSwmsAttachError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
    readonly facts: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "SesSwmsAttachError";
  }
}

export type SesSwmsAttachSelection =
  | { mode: "job_id"; job_id: string }
  | { mode: "job_number"; job_number: string };

export interface SesSwmsAttachRequest {
  selection: SesSwmsAttachSelection;
}

export interface SesSwmsAttachDocumentResult {
  document_id?: string | null;
  url?: string | null;
}

export interface SesSwmsAttachDependencies {
  resolveInput: (
    selection: SesSwmsAttachSelection,
  ) => Promise<SesAssemblerInputV1>;
  planSwms?: (
    input: SesAssemblerInputV1,
  ) => SesSwmsGenerationPlanResult;
  renderSwms?: (
    plan: SesSwmsGenerationPlan,
  ) => Promise<SesRenderResult | null>;
  attachDocument: (
    body: Record<string, unknown>,
    trustedDocumentFacts: {
      data_snapshot_json: Record<string, unknown>;
      attendance_cycle_id: string;
      cycle_attribution: "bound";
    },
  ) => Promise<SesSwmsAttachDocumentResult>;
  ensurePack: (jobId: string, packKind: string) => Promise<void>;
  bindPackSwms: (
    jobId: string,
    packKind: string,
    documentId: string,
  ) => Promise<void>;
  readBack: (
    jobId: string,
    packKind: string,
    documentId: string,
  ) => Promise<{
    document_id: string | null;
    document_type: string | null;
    attendance_cycle_id: string | null;
    cycle_attribution: string | null;
    pack_swms_doc_id: string | null;
    pack_status: string | null;
  }>;
  actor: string;
}

export interface SesSwmsAttachResult {
  action: typeof SES_SWMS_ATTACH_ACTION;
  success: true;
  generated: true;
  attached: true;
  pack_bound: true;
  no_send: true;
  invoice_writes: false;
  notifications_sent: false;
  board_stage_changed: false;
  job_id: string;
  job_number: string | null;
  attendance_cycle_id: string;
  pack_kind: typeof SES_SWMS_ATTACH_PACK_KIND;
  document_id: string;
  document_type: "swms";
  cycle_attribution: "bound";
  pack_swms_doc_id: string;
  pack_status: string;
  file_name: string;
  content_hash: SesSha256;
  render_hash: string | null;
  template_version: string;
  template_kind: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeSesSwmsAttachRequest(
  body: Record<string, unknown>,
): SesSwmsAttachRequest {
  const raw = body.selection && typeof body.selection === "object" &&
      !Array.isArray(body.selection)
    ? body.selection as Record<string, unknown>
    : {};
  const mode = text(raw.mode);
  const jobId = text(raw.job_id);
  const jobNumber = text(raw.job_number);
  if (mode === "job_id" && jobId && !jobNumber) {
    return { selection: { mode, job_id: jobId } };
  }
  if (mode === "job_number" && jobNumber && !jobId) {
    return { selection: { mode, job_number: jobNumber } };
  }
  throw new SesSwmsAttachError(
    "ses_swms_selection_invalid",
    "selection must name exactly one job_id or job_number.",
    400,
  );
}

function resolveRequiredMatrixRow(
  input: SesAssemblerInputV1,
): SesFamilyMatrixRow {
  const matrix = resolveSesFamilyMatrixRow({
    builder_key: input.classification.builder_key,
    family: input.classification.family,
    strata: input.classification.strata,
    own_template_requested: input.classification.own_template_requested,
    site_suburb: input.source.site_suburb,
  });
  if (!matrix.ok) {
    throw new SesSwmsAttachError(
      matrix.failure.code,
      matrix.failure.reason,
      409,
      { recovery_action: matrix.failure.recovery_action },
    );
  }
  if (
    input.classification.report_only !== matrix.row.report_only ||
    input.classification.report_delivery !== matrix.row.report_delivery ||
    input.classification.subtype !== matrix.row.subtype
  ) {
    throw new SesSwmsAttachError(
      "input_hash_conflict",
      "The live card classification does not match the sealed family recipe.",
    );
  }
  const decision = sesSwmsDecision(input, matrix.row);
  if (!decision.included) {
    throw new SesSwmsAttachError(
      "swms_not_required",
      "The sealed family recipe does not include a SWMS for this card.",
      409,
      {
        builder_key: matrix.row.builder_key,
        family: matrix.row.family,
        rule: decision.requirementEvidence,
      },
    );
  }
  return matrix.row;
}

export async function generateAttachMakesafeSwms(
  request: SesSwmsAttachRequest,
  deps: SesSwmsAttachDependencies,
): Promise<SesSwmsAttachResult> {
  const input = await deps.resolveInput(request.selection);
  const matrixRow = resolveRequiredMatrixRow(input);
  const planned = (deps.planSwms || buildSesSwmsGenerationPlan)(input);
  if (!planned.ok) {
    throw new SesSwmsAttachError(
      planned.reason_code,
      planned.reason,
      409,
      {
        ...planned.facts,
        recovery_action: planned.recovery_action,
      },
    );
  }
  const rendered = await (deps.renderSwms || renderSesSwmsPdf)(planned.plan);
  if (!rendered) {
    throw new SesSwmsAttachError(
      "swms_generation_capability_unavailable",
      "The deterministic ops-api SWMS renderer is unavailable.",
      503,
    );
  }
  const contentHash = await sesSha256Bytes(rendered.bytes);
  const cycleId = input.attendance.current_attendance_cycle_id;
  const attached = await deps.attachDocument(
    {
      job_id: input.identity.job_id,
      type: "swms",
      file_name: rendered.file_name,
      pdf_base64: bytesToBase64(rendered.bytes),
      visible_to_trades: true,
      uploaded_by: deps.actor,
    },
    {
      attendance_cycle_id: cycleId,
      cycle_attribution: "bound",
      data_snapshot_json: {
        source: `ops-api:${SES_SWMS_ATTACH_ACTION}`,
        content_hash: contentHash,
        render_hash: rendered.render_hash || null,
        template_version: planned.plan.template_version,
        template_kind: planned.plan.template.kind,
        generator_contract_version: planned.plan.contract_version,
        family_matrix: {
          builder_key: matrixRow.builder_key,
          family: matrixRow.family,
          swms_policy: matrixRow.swms_policy,
        },
        provenance: rendered.provenance || planned.plan.provenance,
      },
    },
  );
  const documentId = text(attached.document_id);
  if (!documentId) {
    throw new SesSwmsAttachError(
      "swms_document_attach_failed",
      "The generated SWMS did not return a typed job document id.",
      500,
    );
  }

  await deps.ensurePack(input.identity.job_id, SES_SWMS_ATTACH_PACK_KIND);
  await deps.bindPackSwms(
    input.identity.job_id,
    SES_SWMS_ATTACH_PACK_KIND,
    documentId,
  );
  const proof = await deps.readBack(
    input.identity.job_id,
    SES_SWMS_ATTACH_PACK_KIND,
    documentId,
  );
  if (
    proof.document_id !== documentId || proof.document_type !== "swms" ||
    proof.attendance_cycle_id !== cycleId ||
    proof.cycle_attribution !== "bound" ||
    proof.pack_swms_doc_id !== documentId || !text(proof.pack_status)
  ) {
    throw new SesSwmsAttachError(
      "swms_attachment_readback_failed",
      "The generated SWMS could not be proved on both the current-cycle document and main pack paths.",
      500,
      proof,
    );
  }

  return {
    action: SES_SWMS_ATTACH_ACTION,
    success: true,
    generated: true,
    attached: true,
    pack_bound: true,
    no_send: true,
    invoice_writes: false,
    notifications_sent: false,
    board_stage_changed: false,
    job_id: input.identity.job_id,
    job_number: input.identity.job_number,
    attendance_cycle_id: cycleId,
    pack_kind: SES_SWMS_ATTACH_PACK_KIND,
    document_id: documentId,
    document_type: "swms",
    cycle_attribution: "bound",
    pack_swms_doc_id: documentId,
    pack_status: text(proof.pack_status),
    file_name: rendered.file_name,
    content_hash: contentHash,
    render_hash: rendered.render_hash || null,
    template_version: planned.plan.template_version,
    template_kind: planned.plan.template.kind,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
