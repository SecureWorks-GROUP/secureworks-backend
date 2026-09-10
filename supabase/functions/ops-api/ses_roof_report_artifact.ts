// Exact source selection and byte provenance for SecureWorks own-letterhead
// roof reports. This module has no database or network dependency so the
// identity rules can be decided in tests before an action wires them to writes.

export const SES_OWN_ROOF_REPORT_SOURCE_KIND = "submitted_roof_report_document";
export const SES_OWN_ROOF_REPORT_EVIDENCE_SOURCE =
  "current_cycle_own_template_roof_report";
export const SES_OWN_ROOF_REPORT_MAX_BYTES = 8 * 1024 * 1024;

/** Raw SHA-256 for source bytes; deliberately excludes the docket content-hash domain. */
export async function rawSha256Bytes(bytes: Uint8Array): Promise<string> {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", owned));
  return `sha256:${Array.from(digest).map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")}`;
}

export interface OwnRoofReportDraftRow {
  id: string;
  job_id: string;
  status?: string | null;
  submitted_cycle?: number | string | null;
  report_doc_id?: string | null;
  updated_at?: string | null;
  last_render_hash?: string | null;
  [key: string]: unknown;
}

export interface OwnRoofReportDocumentRow {
  id: string;
  job_id: string;
  type?: string | null;
  visible_to_trades?: boolean | null;
  file_name?: string | null;
  pdf_url?: string | null;
  storage_url?: string | null;
  url?: string | null;
  attendance_cycle_id?: string | null;
  cycle_attribution?: string | null;
  data_snapshot_json?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface OwnRoofReportBindRequest {
  job_id: string;
  document_id: string;
  expected_current_document_id: string | null;
  expected_draft_updated_at: string;
  expected_current_cycle: number;
  expected_raw_sha256: string;
  expected_raw_size_bytes: number;
  reason?: string | null;
  operator?: string | null;
}

export interface OwnRoofReportArtifact {
  file_name: string;
  media_type: "application/pdf";
  bytes: Uint8Array;
  provenance: Record<string, unknown>;
}

export interface OwnRoofReportResolution {
  ok: true;
  artifact: OwnRoofReportArtifact;
  raw_sha256: string;
  raw_size_bytes: number;
  document: OwnRoofReportDocumentRow;
  draft: OwnRoofReportDraftRow;
}

export interface OwnRoofReportRefusal {
  ok: false;
  code: string;
  reason: string;
  facts?: Record<string, unknown>;
}

export type OwnRoofReportResolutionResult =
  | OwnRoofReportResolution
  | OwnRoofReportRefusal;

export type OwnRoofReportBindValidation = {
  ok: true;
  draft: OwnRoofReportDraftRow;
  document: OwnRoofReportDocumentRow;
  current_cycle_number: number;
} | OwnRoofReportRefusal;

export interface OwnRoofReportArtifactTrustInput {
  artifact: {
    role?: unknown;
    media_type?: unknown;
    size_bytes?: unknown;
    content_hash?: unknown;
    metadata?: unknown;
  };
  job_id: string;
  current_cycle_number: number;
  current_attendance_cycle_id?: string | null;
  draft: OwnRoofReportDraftRow | null | undefined;
  document: OwnRoofReportDocumentRow | null | undefined;
  served_raw_sha256: string;
  served_raw_size_bytes: number;
  served_content_hash: string;
}

export type OwnRoofReportArtifactTrustResult =
  | { ok: true }
  | OwnRoofReportRefusal;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedId(value: unknown): string {
  return text(value).toLowerCase();
}

function rawSha(value: unknown): string {
  const normalized = text(value).toLowerCase().replace(/^sha256:/, "");
  return /^[0-9a-f]{64}$/.test(normalized) ? `sha256:${normalized}` : "";
}

function positiveInteger(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function refusal(
  code: string,
  reason: string,
  facts: Record<string, unknown> = {},
): OwnRoofReportRefusal {
  return { ok: false, code, reason, ...(Object.keys(facts).length ? { facts } : {}) };
}

function documentUrl(document: OwnRoofReportDocumentRow): string {
  return [document.pdf_url, document.storage_url, document.url]
    .map(text)
    .find((value) => value.startsWith("https://")) || "";
}

function documentSnapshot(document: OwnRoofReportDocumentRow): Record<string, unknown> {
  return document.data_snapshot_json &&
      typeof document.data_snapshot_json === "object"
    ? document.data_snapshot_json
    : {};
}

/**
 * Validate the identity and byte stamps at the reporting read boundary. Source
 * bytes and the docket object are downloaded by the caller; this pure check
 * makes the exact current-cycle pointer the deciding authority and rejects a
 * superseded artifact even when its own bytes remain intact.
 */
export function inspectOwnRoofReportArtifactTrust(
  args: OwnRoofReportArtifactTrustInput,
): OwnRoofReportArtifactTrustResult {
  const metadata = args.artifact.metadata && typeof args.artifact.metadata === "object"
    ? args.artifact.metadata as Record<string, unknown>
    : {};
  const selected = validateSelection({
    job_id: args.job_id,
    current_cycle_number: args.current_cycle_number,
    current_attendance_cycle_id: args.current_attendance_cycle_id,
    draft: args.draft,
    documents: args.document ? [args.document] : [],
  });
  if (!selected.ok) return selected;
  if (args.artifact.role !== "supporting_report_pdf" ||
      args.artifact.media_type !== "application/pdf") {
    return refusal(
      "own_roof_report_artifact_role_invalid",
      "The docket artifact is not the typed own-roof supporting PDF.",
    );
  }
  const expectedSourceIdentity = selected.source_identity;
  const expectedDocumentId = text(selected.document.id);
  const metadataSourceKind = text(metadata.source_kind);
  if (metadataSourceKind !== SES_OWN_ROOF_REPORT_SOURCE_KIND) {
    return refusal(
      "own_roof_report_artifact_source_kind_invalid",
      "The own-roof artifact does not identify a submitted roof document source.",
      { source_kind: metadataSourceKind || null },
    );
  }
  if (text(metadata.source_job_id) !== text(args.job_id) ||
      text(metadata.source_draft_id) !== text(selected.draft.id) ||
      text(metadata.source_document_id) !== expectedDocumentId ||
      text(metadata.source_identity) !== expectedSourceIdentity ||
      positiveInteger(metadata.source_cycle_number) !== selected.current_cycle_number ||
      text(metadata.source_attendance_cycle_id) !==
        selected.current_attendance_cycle_id) {
    return refusal(
      "own_roof_report_artifact_identity_stale",
      "The docket artifact does not identify the currently selected submitted-cycle roof document.",
      {
        expected_source_identity: expectedSourceIdentity,
        actual_source_identity: text(metadata.source_identity) || null,
        expected_document_id: expectedDocumentId,
        actual_document_id: text(metadata.source_document_id) || null,
      },
    );
  }
  const expectedRawHash = rawSha(metadata.source_raw_sha256);
  const expectedRawSize = positiveInteger(metadata.source_raw_size_bytes);
  if (!expectedRawHash || expectedRawSize === null ||
      expectedRawHash !== rawSha(args.served_raw_sha256) ||
      expectedRawSize !== args.served_raw_size_bytes ||
      expectedRawSize !== positiveInteger(args.artifact.size_bytes) ||
      text(metadata.output_content_hash) !== text(args.served_content_hash) ||
      text(args.artifact.content_hash) !== text(args.served_content_hash)) {
    return refusal(
      "own_roof_report_artifact_bytes_mismatch",
      "The served own-roof artifact bytes do not match their stamped raw and output hashes.",
      {
        expected_raw_sha256: expectedRawHash || null,
        served_raw_sha256: rawSha(args.served_raw_sha256) || null,
        expected_raw_size_bytes: expectedRawSize,
        served_raw_size_bytes: args.served_raw_size_bytes,
        artifact_content_hash: text(args.artifact.content_hash) || null,
        served_content_hash: text(args.served_content_hash) || null,
      },
    );
  }
  const snapshot = documentSnapshot(selected.document);
  const stampedHash = rawSha(snapshot.own_roof_source_raw_sha256);
  const stampedSize = positiveInteger(snapshot.own_roof_source_raw_size_bytes);
  if (!stampedHash || stampedSize === null || stampedHash !== expectedRawHash ||
      stampedSize !== expectedRawSize) {
    return refusal(
      "own_roof_report_source_stamp_missing",
      "The selected roof document has no matching stamped raw-byte provenance.",
      { document_id: selected.document.id },
    );
  }
  return { ok: true };
}

function sourceIdentity(
  jobId: string,
  cycleId: string,
  cycleNumber: number,
  draftId: string,
  documentId: string,
): string {
  return `own-roof:job:${jobId}/cycle:${cycleId || cycleNumber}/draft:${draftId}/document:${documentId}`;
}

function selectOwnRoofDocument(
  jobId: string,
  documentId: string,
  documents: OwnRoofReportDocumentRow[],
): OwnRoofReportDocumentRow | OwnRoofReportRefusal {
  const matches = documents.filter((row) => normalizedId(row.id) === normalizedId(documentId));
  if (matches.length === 0) {
    return refusal(
      "own_roof_report_document_missing",
      "The submitted roof draft points at a document that is not attached to the selected job.",
      { job_id: jobId, document_id: documentId },
    );
  }
  if (matches.length !== 1) {
    return refusal(
      "own_roof_report_document_ambiguous",
      "The submitted roof draft pointer does not resolve to exactly one document row.",
      { job_id: jobId, document_id: documentId, match_count: matches.length },
    );
  }
  const document = matches[0];
  if (normalizedId(document.job_id) !== normalizedId(jobId)) {
    return refusal(
      "own_roof_report_document_wrong_job",
      "The selected roof document belongs to a different job.",
      { expected_job_id: jobId, actual_job_id: document.job_id, document_id: document.id },
    );
  }
  if (text(document.type).toLowerCase() !== "roof_report") {
    return refusal(
      "own_roof_report_document_wrong_type",
      "The selected roof document is not typed roof_report.",
      { document_id: document.id, actual_type: document.type || null },
    );
  }
  if (document.visible_to_trades !== true) {
    return refusal(
      "own_roof_report_document_not_visible",
      "The selected roof document is not visible to the operational reader.",
      { document_id: document.id },
    );
  }
  if (!documentUrl(document)) {
    return refusal(
      "own_roof_report_document_url_missing",
      "The selected roof document has no recoverable HTTPS URL.",
      { document_id: document.id },
    );
  }
  return document;
}

function validateSelection(args: {
  job_id: string;
  current_cycle_number: number;
  current_attendance_cycle_id?: string | null;
  draft: OwnRoofReportDraftRow | null | undefined;
  documents: OwnRoofReportDocumentRow[];
}): {
  ok: true;
  draft: OwnRoofReportDraftRow;
  document: OwnRoofReportDocumentRow;
  current_cycle_number: number;
  current_attendance_cycle_id: string;
  source_identity: string;
} | OwnRoofReportRefusal {
  const jobId = text(args.job_id);
  const cycleNumber = positiveInteger(args.current_cycle_number);
  const cycleId = text(args.current_attendance_cycle_id);
  if (!jobId || cycleNumber === null) {
    return refusal(
      "own_roof_report_current_cycle_unresolved",
      "The selected job's current attendance cycle is not a positive integer.",
      { job_id: jobId, current_cycle_number: args.current_cycle_number },
    );
  }
  const draft = args.draft;
  if (!draft) {
    return refusal(
      "own_roof_report_draft_missing",
      "No own-template roof draft exists for the selected job.",
      { job_id: jobId, current_cycle_number: cycleNumber },
    );
  }
  if (normalizedId(draft.job_id) !== normalizedId(jobId)) {
    return refusal(
      "own_roof_report_draft_wrong_job",
      "The roof draft belongs to a different job.",
      { expected_job_id: jobId, actual_job_id: draft.job_id },
    );
  }
  if (text(draft.status).toLowerCase() !== "submitted") {
    return refusal(
      "own_roof_report_draft_not_submitted",
      "The roof draft is not submitted for operational consumption.",
      { draft_id: draft.id, status: draft.status || null },
    );
  }
  const submittedCycle = positiveInteger(draft.submitted_cycle);
  if (submittedCycle === null || submittedCycle !== cycleNumber) {
    return refusal(
      "own_roof_report_draft_cycle_mismatch",
      "The roof draft was submitted for a different attendance cycle.",
      {
        draft_id: draft.id,
        submitted_cycle: draft.submitted_cycle ?? null,
        current_cycle_number: cycleNumber,
      },
    );
  }
  const documentId = text(draft.report_doc_id);
  if (!documentId) {
    return refusal(
      "own_roof_report_document_pointer_missing",
      "The submitted roof draft has no selected document pointer.",
      { draft_id: draft.id, current_cycle_number: cycleNumber },
    );
  }
  const selected = selectOwnRoofDocument(jobId, documentId, args.documents);
  if ("ok" in selected && selected.ok === false) {
    return selected as OwnRoofReportRefusal;
  }
  const document = selected as OwnRoofReportDocumentRow;
  const documentCycleId = text(document.attendance_cycle_id);
  if (documentCycleId && cycleId && documentCycleId !== cycleId) {
    return refusal(
      "own_roof_report_document_cycle_mismatch",
      "The selected roof document is stamped for a different attendance cycle.",
      {
        document_id: document.id,
        document_attendance_cycle_id: documentCycleId,
        current_attendance_cycle_id: cycleId,
      },
    );
  }
  return {
    ok: true,
    draft,
    document,
    current_cycle_number: cycleNumber,
    current_attendance_cycle_id: cycleId,
    source_identity: sourceIdentity(
      jobId,
      cycleId,
      cycleNumber,
      text(draft.id),
      text(document.id),
    ),
  };
}

export async function resolveOwnRoofReportArtifact(args: {
  job_id: string;
  current_cycle_number: number;
  current_attendance_cycle_id?: string | null;
  draft: OwnRoofReportDraftRow | null | undefined;
  documents: OwnRoofReportDocumentRow[];
  expected_raw_sha256?: string | null;
  expected_raw_size_bytes?: number | null;
  /** Bind may explicitly supersede a previously stamped source on this row. */
  allow_expected_hash_supersession?: boolean;
  download: (url: string) => Promise<Uint8Array>;
}): Promise<OwnRoofReportResolutionResult> {
  const selected = validateSelection(args);
  if (!selected.ok) return selected;
  const expectedHash = args.expected_raw_sha256 == null
    ? null
    : rawSha(args.expected_raw_sha256);
  if (args.expected_raw_sha256 != null && !expectedHash) {
    return refusal(
      "own_roof_report_source_hash_invalid",
      "The expected own-roof source SHA-256 is not canonical.",
    );
  }
  const expectedSize = args.expected_raw_size_bytes == null
    ? null
    : positiveInteger(args.expected_raw_size_bytes);
  if (args.expected_raw_size_bytes != null && expectedSize === null) {
    return refusal(
      "own_roof_report_source_size_invalid",
      "The expected own-roof source size is not a positive integer.",
    );
  }
  const snapshot = documentSnapshot(selected.document);
  const stampedHash = rawSha(
    snapshot.own_roof_source_raw_sha256 ?? snapshot.source_raw_sha256,
  );
  const stampedSize = snapshot.own_roof_source_raw_size_bytes ??
    snapshot.source_raw_size_bytes;
  const stampedSizeNumber = stampedSize == null ? null : positiveInteger(stampedSize);
  const hasHashStamp = Object.prototype.hasOwnProperty.call(
    snapshot,
    "own_roof_source_raw_sha256",
  ) || Object.prototype.hasOwnProperty.call(snapshot, "source_raw_sha256");
  const hasSizeStamp = Object.prototype.hasOwnProperty.call(
    snapshot,
    "own_roof_source_raw_size_bytes",
  ) || Object.prototype.hasOwnProperty.call(snapshot, "source_raw_size_bytes");
  if ((hasHashStamp || hasSizeStamp) &&
      (!stampedHash || stampedSizeNumber === null)) {
    return refusal(
      "own_roof_report_source_provenance_invalid",
      "The selected roof document carries an invalid raw-byte provenance stamp.",
      { document_id: selected.document.id },
    );
  }
  if (stampedHash && expectedHash && stampedHash !== expectedHash &&
      args.allow_expected_hash_supersession !== true) {
    return refusal(
      "own_roof_report_source_hash_conflict",
      "The expected source hash conflicts with the selected document's existing provenance stamp.",
      {
        document_id: selected.document.id,
        stamped_raw_sha256: stampedHash,
        expected_raw_sha256: expectedHash,
      },
    );
  }
  if (stampedSizeNumber !== null && expectedSize !== null &&
      stampedSizeNumber !== expectedSize &&
      args.allow_expected_hash_supersession !== true) {
    return refusal(
      "own_roof_report_source_size_conflict",
      "The expected source size conflicts with the selected document's existing provenance stamp.",
      {
        document_id: selected.document.id,
        stamped_raw_size_bytes: stampedSizeNumber,
        expected_raw_size_bytes: expectedSize,
      },
    );
  }
  const url = documentUrl(selected.document);
  let bytes: Uint8Array;
  try {
    bytes = await args.download(url);
  } catch (error) {
    return refusal(
      "own_roof_report_source_bytes_unreadable",
      "The selected roof document bytes could not be recovered.",
      { document_id: selected.document.id, message: String((error as Error)?.message || error) },
    );
  }
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  if (
    owned.byteLength === 0 || owned.byteLength > SES_OWN_ROOF_REPORT_MAX_BYTES ||
    new TextDecoder().decode(owned.slice(0, 5)) !== "%PDF-"
  ) {
    return refusal(
      "own_roof_report_source_not_pdf",
      "The selected roof document bytes are not a bounded PDF artifact.",
      { document_id: selected.document.id, size_bytes: owned.byteLength },
    );
  }
  const rawSha256 = await rawSha256Bytes(owned);
  const rawSize = owned.byteLength;
  // A normal read validates every present stamp. The bind action is the one
  // explicit supersession path: its expected hash/size intentionally replaces
  // the old row stamp after the old pointer/draft CAS has been checked.
  const expectedDocumentHash = expectedHash || stampedHash;
  const expectedDocumentSize = expectedSize || stampedSizeNumber;
  if (
    (expectedDocumentHash && rawSha256 !== expectedDocumentHash) ||
    (expectedDocumentSize !== null && rawSize !== expectedDocumentSize)
  ) {
    return refusal(
      "own_roof_report_source_hash_mismatch",
      "The selected roof document bytes do not match the expected raw-byte provenance.",
      {
        document_id: selected.document.id,
        expected_raw_sha256: expectedDocumentHash,
        actual_raw_sha256: rawSha256,
        expected_raw_size_bytes: expectedDocumentSize,
        actual_raw_size_bytes: rawSize,
      },
    );
  }
  const fileName = text(selected.document.file_name) ||
    `Roof Report - ${text(args.job_id)}.pdf`;
  return {
    ok: true,
    artifact: {
      file_name: fileName,
      media_type: "application/pdf",
      bytes: owned,
      provenance: {
        evidence_source: SES_OWN_ROOF_REPORT_EVIDENCE_SOURCE,
        source_kind: SES_OWN_ROOF_REPORT_SOURCE_KIND,
        source_identity: selected.source_identity,
        source_job_id: text(args.job_id),
        source_draft_id: text(selected.draft.id),
        source_document_id: text(selected.document.id),
        source_attendance_cycle_id: selected.current_attendance_cycle_id || null,
        source_cycle_number: selected.current_cycle_number,
        source_raw_sha256: rawSha256,
        source_raw_size_bytes: rawSize,
      },
    },
    raw_sha256: rawSha256,
    raw_size_bytes: rawSize,
    document: selected.document,
    draft: selected.draft,
  };
}

export function validateOwnRoofReportBind(args: {
  request: OwnRoofReportBindRequest;
  draft: OwnRoofReportDraftRow | null | undefined;
  current_cycle_number: number;
  document: OwnRoofReportDocumentRow | null | undefined;
}): OwnRoofReportBindValidation {
  const request = args.request;
  if (!text(request.job_id) || !text(request.document_id)) {
    return refusal(
      "own_roof_report_bind_identity_missing",
      "A roof bind requires a selected job and document id.",
    );
  }
  if (!Object.prototype.hasOwnProperty.call(request, "expected_current_document_id")) {
    return refusal(
      "own_roof_report_bind_expected_pointer_missing",
      "A roof bind must state the expected current document pointer, including explicit null.",
    );
  }
  if (!text(request.expected_draft_updated_at)) {
    return refusal(
      "own_roof_report_bind_expected_version_missing",
      "A roof bind must state the expected draft updated_at CAS coordinate.",
    );
  }
  const cycle = positiveInteger(args.current_cycle_number);
  if (cycle === null || request.expected_current_cycle !== cycle) {
    return refusal(
      "own_roof_report_bind_cycle_conflict",
      "The requested roof bind cycle is not the selected job's current cycle.",
      { expected_current_cycle: request.expected_current_cycle, current_cycle_number: cycle },
    );
  }
  const draft = args.draft;
  if (!draft || normalizedId(draft.job_id) !== normalizedId(request.job_id)) {
    return refusal(
      "own_roof_report_bind_draft_missing",
      "The submitted roof draft for the selected job could not be read.",
      { job_id: request.job_id },
    );
  }
  const livePointer = text(draft.report_doc_id) || null;
  const expectedPointer = text(request.expected_current_document_id) || null;
  if (livePointer !== expectedPointer) {
    return refusal(
      "own_roof_report_bind_stale_pointer",
      "The roof draft selected document changed since the bind was prepared.",
      { expected_current_document_id: expectedPointer, actual_current_document_id: livePointer },
    );
  }
  if (text(draft.updated_at) !== text(request.expected_draft_updated_at)) {
    return refusal(
      "own_roof_report_bind_stale_draft",
      "The roof draft changed since the bind was prepared.",
      { expected_draft_updated_at: request.expected_draft_updated_at, actual_updated_at: draft.updated_at || null },
    );
  }
  if (text(draft.status).toLowerCase() !== "submitted" ||
      positiveInteger(draft.submitted_cycle) !== cycle) {
    return refusal(
      "own_roof_report_bind_draft_cycle_conflict",
      "The roof draft is no longer the submitted draft for the current cycle.",
      { draft_id: draft.id, status: draft.status || null, submitted_cycle: draft.submitted_cycle ?? null },
    );
  }
  const document = args.document;
  if (!document || normalizedId(document.id) !== normalizedId(request.document_id)) {
    return refusal(
      "own_roof_report_bind_document_missing",
      "The requested roof document could not be read.",
      { document_id: request.document_id },
    );
  }
  const selection = selectOwnRoofDocument(request.job_id, request.document_id, [document]);
  if ("ok" in selection && selection.ok === false) {
    return selection as OwnRoofReportRefusal;
  }
  const expectedHash = rawSha(request.expected_raw_sha256);
  const expectedSize = positiveInteger(request.expected_raw_size_bytes);
  if (!expectedHash || expectedSize === null) {
    return refusal(
      "own_roof_report_bind_expected_bytes_invalid",
      "A roof bind requires canonical expected raw PDF SHA-256 and size.",
    );
  }
  return {
    ok: true,
    draft,
    document,
    current_cycle_number: cycle,
  };
}

export function buildOwnRoofSupersessionAudit(args: {
  request: OwnRoofReportBindRequest;
  draft: OwnRoofReportDraftRow;
  document: OwnRoofReportDocumentRow;
  source_raw_sha256: string;
  source_raw_size_bytes: number;
  actor: string;
  reason?: string | null;
  prior_source_identity?: string | null;
  prior_source_raw_sha256?: string | null;
}): Record<string, unknown> {
  const request = args.request;
  const priorDocumentId = text(request.expected_current_document_id) || null;
  const currentDocumentId = text(request.document_id);
  return {
    operation: "own_roof_report_bind",
    supersedes_prior_bind: Boolean(priorDocumentId && priorDocumentId !== currentDocumentId),
    job_id: text(request.job_id),
    draft_id: text(args.draft.id),
    document_id: currentDocumentId,
    prior_document_id: priorDocumentId,
    prior_source_identity: text(args.prior_source_identity) || null,
    prior_source_raw_sha256: rawSha(args.prior_source_raw_sha256) || null,
    prior_draft_updated_at: text(request.expected_draft_updated_at),
    expected_current_cycle: request.expected_current_cycle,
    source_identity:
      `own-roof:job:${text(request.job_id)}/cycle:${text(args.document.attendance_cycle_id) || request.expected_current_cycle}/draft:${text(args.draft.id)}/document:${currentDocumentId}`,
    source_raw_sha256: rawSha(args.source_raw_sha256),
    source_raw_size_bytes: args.source_raw_size_bytes,
    source_file_name: text(args.document.file_name) || null,
    actor: text(args.actor) || "unknown",
    reason: text(args.reason) || "explicit reviewed own-roof document bind",
  };
}

export function ownRoofReportSourceUrl(document: OwnRoofReportDocumentRow): string {
  return documentUrl(document);
}
