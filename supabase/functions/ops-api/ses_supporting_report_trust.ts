import {
  isCurrentCuratedRendererVersion,
  MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256,
  MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION,
  MAKESAFE_REPORT_CONTRACT_VERSION,
} from "./makesafe_report_render.ts";

export type SesSupportingReportTrust =
  | { trusted: true }
  | { trusted: false; reason: string };

export const SES_SUPPORTING_REPORT_MAX_BYTES = 8 * 1024 * 1024;

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
  const artifactId = String(artifact.id || "");
  // Check 8: independent provenance / no self-vouching. A pack artifact must
  // not certify itself by pointing its "independent" source at its own id, nor
  // by equating source identity with the document being certified.
  if (
    !sourceIdentity || !sourceDocumentId ||
    sourceIdentity === sourceDocumentId ||
    (artifactId && sourceArtifactId === artifactId)
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
  // Restorable is not complete. A previously-committed same-cycle PDF whose
  // only proof is its own docket metadata (content-hash self-match, no bind-time
  // report_input_hash) can self-certify an incomplete pack — Tuart Hill
  // SWMS-261015 is the concrete instance (thin 8-of-23, no input hash). The
  // report_input_hash is the independent completeness coordinate produced by
  // the curated bind's photo/contact/materials accounting; without it this path
  // is decorative. Sibling-bundle evidence is a different independence model
  // and is not gated here.
  if (
    sourceKind === "previously_committed_pdf" &&
    evidenceSource === "current_cycle_curated_makesafe_report" &&
    !sha256Shape(metadata.report_input_hash)
  ) {
    return { trusted: false, reason: "independent_completeness_proof_missing" };
  }
  const size = Number(artifact.size_bytes);
  if (
    !Number.isSafeInteger(size) || size <= 0 ||
    size > SES_SUPPORTING_REPORT_MAX_BYTES
  ) {
    return { trusted: false, reason: "pdf_size_budget_invalid" };
  }
  return { trusted: true };
}

export function rawSesSupportingReportSha(value: unknown): string {
  return rawSha(value);
}

/** Audit event type written by every curated source bind, first or superseding. */
export const SES_CURATED_SOURCE_BIND_EVENT_TYPE =
  "ses_curated_report_source_bind_validated";

/**
 * A docket revision keeps its own consistent copy of the bytes it was built
 * from, so a trusted content supersession on the source document cannot be
 * seen by artifact self-verification alone. These two reasons are how a
 * revision built from superseded content stops being served.
 */
export const SES_CURATED_SOURCE_SUPERSEDED_REASON = "curated_source_superseded";
export const SES_CURATED_SOURCE_SUPERSESSION_UNREADABLE_REASON =
  "curated_source_supersession_unreadable";

interface SesCuratedSourceStamp {
  raw_sha256: string;
  source_identity: string;
  report_input_hash: string;
}

export interface SesCuratedSourceSupersession {
  document_id: string;
  superseded: SesCuratedSourceStamp;
  current: SesCuratedSourceStamp;
}

function curatedStamp(
  raw: unknown,
  identity: unknown,
  inputHash: unknown,
): SesCuratedSourceStamp {
  return {
    raw_sha256: rawSha(raw),
    source_identity: String(identity || "").trim(),
    report_input_hash: rawSha(inputHash),
  };
}

function sameCuratedStamp(
  left: SesCuratedSourceStamp,
  right: SesCuratedSourceStamp,
): boolean {
  return left.raw_sha256 === right.raw_sha256 &&
    left.source_identity === right.source_identity &&
    left.report_input_hash === right.report_input_hash;
}

/**
 * Reads the curated-bind audit trail of ONE job into the supersession pairs it
 * records. Rows must be the job's own `job_events` rows for
 * `SES_CURATED_SOURCE_BIND_EVENT_TYPE`; they are ordered oldest first here, so
 * the last entry for a document carries its currently bound stamp.
 *
 * A supersession whose superseded and current stamps are identical (a re-bind
 * that changed only renderer constants, say) records nothing: it moved no
 * builder-visible content, so nothing it produced is stale.
 */
export function sesCuratedSourceSupersessionsFromEvents(
  rows: Array<Record<string, unknown>>,
): SesCuratedSourceSupersession[] {
  const ordered = rows.slice().sort((left, right) =>
    String(left.created_at || "").localeCompare(String(right.created_at || ""))
  );
  const supersessions: SesCuratedSourceSupersession[] = [];
  for (const row of ordered) {
    const detail = object(row.detail_json);
    if (detail.supersedes_prior_bind !== true) continue;
    const documentId = String(detail.document_id || "").trim();
    const priorSnapshot = object(detail.prior_data_snapshot_json);
    const superseded = curatedStamp(
      detail.prior_expected_raw_sha256 ??
        priorSnapshot.curated_source_expected_raw_sha256,
      detail.prior_source_identity ?? priorSnapshot.curated_source_identity,
      detail.prior_report_input_hash ?? priorSnapshot.report_input_hash,
    );
    const current = curatedStamp(
      detail.expected_raw_sha256,
      detail.source_identity,
      detail.report_input_hash,
    );
    if (
      !documentId || !superseded.raw_sha256 || !superseded.source_identity ||
      !current.raw_sha256 || sameCuratedStamp(superseded, current)
    ) continue;
    supersessions.push({ document_id: documentId, superseded, current });
  }
  return supersessions;
}

/**
 * True when this stored docket artifact was built from content that a later
 * curated bind superseded. Scoped to the artifact's OWN source document and to
 * the exact superseded stamp: an artifact carrying the currently bound content
 * is never marked, and no other card, cycle or document is reached.
 *
 * The prior revision is untouched audit history. Clearing this state is a
 * separate gated write: `prepare_ses_docket_revision` (dry_run, then live).
 */
export function sesSupportingReportIsSuperseded(
  artifact: Record<string, unknown>,
  supersessions: SesCuratedSourceSupersession[],
): boolean {
  const metadata = object(artifact.metadata);
  const sourceKind = String(metadata.source_kind || "");
  const documentId = String(
    metadata.source_document_id || metadata.report_document_id || "",
  ).trim();
  if (!documentId) return false;
  const scoped = supersessions.filter((row) => row.document_id === documentId);
  if (scoped.length === 0) return false;
  const bound = scoped[scoped.length - 1].current;
  const stamp = curatedStamp(
    metadata.expected_raw_sha256,
    metadata.source_identity,
    metadata.report_input_hash,
  );
  if (sourceKind === "durable_curated_revision") {
    if (sameCuratedStamp(stamp, bound)) return false;
    return scoped.some((row) => sameCuratedStamp(stamp, row.superseded));
  }
  // A previously committed PDF names its docket revision rather than the
  // curation identity, so only the raw bytes of the source document can be
  // compared. Superseded bytes stay superseded whichever artifact serves them.
  if (sourceKind === "previously_committed_pdf") {
    if (!stamp.raw_sha256 || stamp.raw_sha256 === bound.raw_sha256) {
      return false;
    }
    return scoped.some((row) => row.superseded.raw_sha256 === stamp.raw_sha256);
  }
  return false;
}
