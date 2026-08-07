import { MAKESAFE_REPORT_CONTRACT_VERSION } from "./makesafe_report_render.ts";
import { makesafeRendererStampAuthorisedAtBind } from "./makesafe_report_renderer_authority.ts";

export type SesSupportingReportTrust =
  | { trusted: true }
  | { trusted: false; reason: string };

/**
 * Facts about the artifact's own curated bind that this pure inspection cannot
 * read for itself. Today that is one thing: WHEN the source document's current
 * curated bind was made, so the renderer identity it stamped can be judged
 * against the register window that was open at the time rather than against
 * whatever pin happens to be current.
 *
 * Omitting it is safe by construction — the register accepts the current
 * identity with no instant, so an unaware caller gets exactly the behaviour that
 * existed before bind-time validity. It is only an OLDER identity that needs the
 * instant, and only inside that identity's own closed window.
 */
export interface SesSupportingReportTrustContext {
  /** ISO instant of the source document's current curated bind, if known. */
  curated_bind_at?: string | null;
}

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

export type SesSupportingReportDocumentBinding =
  | "matched"
  | "diverged"
  | "absent";

// A report_input_hash is a completeness coordinate for the bytes the DOCUMENT
// carries, whichever side stamped it. When the document's own raw hash names
// different bytes than the artifact, the artifact is a stale or thinner render
// and no coordinate describes it. Selection and the served-pack read must
// answer this the same way, so the rule lives here once.
export function sesSupportingReportDocumentBinding(
  artifactRawSha256: unknown,
  documentProvenance: unknown,
): SesSupportingReportDocumentBinding {
  const provenance = object(documentProvenance);
  const documentRaw = rawSha(
    provenance.curated_source_expected_raw_sha256 ||
      provenance.report_render_hash,
  );
  if (!documentRaw) return "absent";
  const artifactRaw = rawSha(artifactRawSha256);
  return artifactRaw && artifactRaw === documentRaw ? "matched" : "diverged";
}

export function inspectSesSupportingReportProof(
  artifact: Record<string, unknown>,
  context: SesSupportingReportTrustContext = {},
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
  // The renderer identity is judged against the register window that was open
  // when this artifact's source document was bound, not against today's pin.
  // Re-pinning does not make a past bind false, and this check must not say it
  // does. A bind made NOW still has to carry the current pin exactly: the
  // register only opens an older identity for an instant inside that identity's
  // own closed window, and no instant at all leaves the current pin the only
  // acceptable stamp.
  if (
    sourceKind === "durable_curated_revision" &&
    (!sha256Shape(metadata.report_input_hash) ||
      !makesafeRendererStampAuthorisedAtBind({
        version: metadata.report_renderer_version,
        source_revision: metadata.report_renderer_source_revision,
        script_sha256: metadata.report_renderer_script_sha256,
      }, context.curated_bind_at))
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
 * Ordering is on PARSED instants, the same rule as
 * `sesCuratedBindInstantsByDocument` below, because both read the identical row
 * set and must never disagree about which event is newest: a representation
 * drift ("Z" beside "+00:00") that picked the wrong `current` stamp would clear
 * a supersession and serve a superseded report to a builder.
 *
 * An unparseable `created_at` sorts NEWEST here, and that is deliberately the
 * OPPOSITE placement to `sesCuratedBindInstantsByDocument` below. The two ask
 * different questions and each fails closed its own way. "Was this renderer
 * authorised at bind time" fails closed by supplying NO instant, which leaves
 * the current pin the only acceptable stamp. "Has this content been superseded"
 * fails closed by treating the unplaceable event's stamp as the bound one, which
 * suppresses MORE: if we cannot tell when an event happened, the prior stamps
 * stay superseded. Sorting it oldest there would make a superseded report
 * servable, so do not harmonise the two — the asymmetry is the point.
 *
 * A supersession whose superseded and current stamps are identical (a re-bind
 * that changed only renderer constants, say) records nothing: it moved no
 * builder-visible content, so nothing it produced is stale.
 */
export function sesCuratedSourceSupersessionsFromEvents(
  rows: Array<Record<string, unknown>>,
): SesCuratedSourceSupersession[] {
  const orderable = (value: unknown): number => {
    const parsed = Date.parse(String(value || "").trim());
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
  };
  const ordered = rows
    .map((row, index) => ({ row, index, at: orderable(row.created_at) }))
    .sort((left, right) =>
      left.at === right.at ? left.index - right.index : left.at - right.at
    )
    .map((entry) => entry.row);
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
 * When each document's CURRENT curated bind was made, read off the same
 * append-only audit trail as the supersessions above (a job's own `job_events`
 * rows for `SES_CURATED_SOURCE_BIND_EVENT_TYPE`). The event is written by the
 * server immediately before the snapshot it describes, so its `created_at` is
 * the bind's own instant — it is never supplied by a caller and never rewritten.
 *
 * The LATEST event per document wins, deliberately. A document re-bound under a
 * newer renderer is described by its newest bind; letting an older event keep
 * vouching would be exactly the stale claim this coordinate exists to catch. The
 * paths that write no event (an exact-snapshot skip, a cycle-column CAS repair)
 * change no provenance, so the latest event still describes what is stored.
 *
 * A document with no bind event gets no instant, and the register then accepts
 * only the current pin for it. That is the pre-existing refusal, not a new one.
 *
 * "Newest" is decided on PARSED instants, never on text order: this map is the
 * sole authority for which bind vouches for a document, so a representation
 * drift ("Z" beside "+00:00") must not silently pick the wrong event. An
 * unparseable `created_at` is DISCARDED rather than allowed to win, which is
 * this question's fail-closed direction: a document left with no instant is
 * judged against the current pin alone. That is the opposite placement to the
 * supersession reader above, and deliberately so — see the asymmetry recorded
 * there before making the two agree.
 */
export function sesCuratedBindInstantsByDocument(
  rows: Array<Record<string, unknown>>,
): Map<string, string> {
  const latest = new Map<string, { value: string; at: number }>();
  for (const row of rows) {
    const documentId = String(object(row.detail_json).document_id || "").trim();
    const createdAt = String(row.created_at || "").trim();
    if (!documentId || !createdAt) continue;
    const at = Date.parse(createdAt);
    if (!Number.isFinite(at)) continue;
    const held = latest.get(documentId);
    if (!held || held.at < at) latest.set(documentId, { value: createdAt, at });
  }
  return new Map(
    Array.from(latest.entries()).map(([id, held]) => [id, held.value]),
  );
}

/** The bind instant an artifact's own source document carries, or `null`. */
export function sesCuratedBindInstantForArtifact(
  artifact: Record<string, unknown>,
  instants: Map<string, string>,
): string | null {
  const metadata = object(artifact.metadata);
  const documentId = String(
    metadata.source_document_id || metadata.report_document_id || "",
  ).trim();
  return (documentId && instants.get(documentId)) || null;
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
