import {
  isCurrentCuratedRendererVersion,
  MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256,
  MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION,
  MAKESAFE_REPORT_CONTRACT_VERSION,
} from "./makesafe_report_render.ts";

export type SesSupportingReportTrust =
  | { trusted: true }
  | { trusted: false; reason: string };

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

function sha256Shape(value: unknown): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(String(value || ""));
}

function rawSha(value: unknown): string {
  const normalized = String(value || "").toLowerCase().replace(/^sha256:/, "");
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : "";
}

export function inspectSesSupportingReportProof(
  artifact: Record<string, unknown>,
): SesSupportingReportTrust {
  if (
    artifact.role !== "supporting_report_pdf" ||
    artifact.media_type !== "application/pdf"
  ) return { trusted: false, reason: "not_a_supporting_report_pdf" };
  const metadata = object(artifact.metadata);
  const sourceKind = String(metadata.source_kind || "");
  if (
    sourceKind !== "durable_curated_revision" &&
    sourceKind !== "previously_committed_pdf"
  ) return { trusted: false, reason: "independent_source_kind_missing" };
  const sourceIdentity = String(metadata.source_identity || "");
  const sourceDocumentId = String(
    metadata.source_document_id || metadata.report_document_id || "",
  );
  const sourceRevisionId = String(metadata.source_revision_id || "");
  const sourceArtifactId = String(metadata.source_artifact_id || "");
  if (
    !sourceIdentity || !sourceDocumentId ||
    sourceIdentity === sourceDocumentId
  ) {
    return { trusted: false, reason: "source_identity_self_reference" };
  }
  if (
    !sourceRevisionId || !sourceArtifactId ||
    sourceIdentity !==
      (sourceKind === "durable_curated_revision"
        ? `curation-revision:${sourceRevisionId}/artifact:${sourceArtifactId}`
        : `docket-revision:${sourceRevisionId}/artifact:${sourceArtifactId}`)
  ) {
    return { trusted: false, reason: "source_revision_identity_missing" };
  }
  if (
    !sha256Shape(metadata.source_artifact_content_hash) ||
    metadata.source_artifact_content_hash !== artifact.content_hash
  ) {
    return { trusted: false, reason: "source_artifact_content_hash_mismatch" };
  }
  const expectedRaw = rawSha(metadata.expected_raw_sha256);
  const outputRaw = rawSha(metadata.output_sha256);
  const renderRaw = rawSha(metadata.render_hash);
  if (!expectedRaw || expectedRaw !== outputRaw || expectedRaw !== renderRaw) {
    return { trusted: false, reason: "raw_pdf_hash_binding_mismatch" };
  }
  const evidenceSource = String(metadata.evidence_source || "");
  if (
    ![
      "current_cycle_curated_makesafe_report",
      "explicit_sibling_bundle",
    ].includes(evidenceSource) ||
    metadata.report_contract_version !== MAKESAFE_REPORT_CONTRACT_VERSION
  ) {
    return { trusted: false, reason: "curated_contract_provenance_missing" };
  }
  if (
    evidenceSource === "explicit_sibling_bundle" &&
    (!String(metadata.bundle_id || "") ||
      !String(metadata.sibling_job_id || "") ||
      !String(metadata.binding_revision_id || ""))
  ) {
    return { trusted: false, reason: "sibling_bundle_provenance_missing" };
  }
  if (
    sourceKind === "durable_curated_revision" &&
    (!sha256Shape(metadata.report_input_hash) ||
      !isCurrentCuratedRendererVersion(metadata.report_renderer_version) ||
      metadata.report_renderer_source_revision !==
        MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION ||
      metadata.report_renderer_script_sha256 !==
        MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256)
  ) {
    return { trusted: false, reason: "active_renderer_input_binding_missing" };
  }
  const size = Number(artifact.size_bytes);
  if (!Number.isSafeInteger(size) || size <= 0 || size > 8 * 1024 * 1024) {
    return { trusted: false, reason: "pdf_size_budget_invalid" };
  }
  return { trusted: true };
}

export function rawSesSupportingReportSha(value: unknown): string {
  return rawSha(value);
}
