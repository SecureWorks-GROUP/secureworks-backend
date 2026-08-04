// SES Reporting U4 live adapter.
//
// This is the only ops-api boundary that turns a live make-safe card into the
// sealed ses.assembler-input/v1 contract. It reads facts and recovers bytes; it
// does not classify by prose, mutate operational rows, send, invoice or close.

import {
  SES_ASSEMBLER_VERSION,
  SES_INPUT_CONTRACT_VERSION,
  type SesArtifact,
  type SesAssemblerInputV1,
  type SesDeliveryRenderRoute,
  type SesPhysicalReportProof,
  type SesPortalCapture,
  type SesPreparedRevision,
  type SesPrepareRequest,
  type SesSha256,
  sesSha256Bytes,
  type SesSiblingBundleEvidence,
} from "./ses_docket_envelope.ts";
import {
  canonicalSesFamilyFromCard,
  resolveSesFamilyMatrixRow,
  SES_FAMILY_MATRIX_VERSION,
  type SesBuilderKey,
  type SesFamilyId,
} from "./ses_family_matrix.ts";
import {
  currentCycleNumber,
  filterAssignmentsForCurrentCycle,
  filterMediaForCurrentCycle,
  isEvidenceBoundToCurrentCycle,
  selectCurrentCycleReport,
} from "./makesafe_cycle_evidence.ts";
import { extractPortalLinks } from "./makesafe_portal_guard.ts";
import {
  SES_ASSESSMENT_RECIPE_VERSION,
  type SesPhotoArtifact,
  type SesPhotoProof,
  type SesPortalCaptureRequest,
  type SesPrepareDependencies,
  type SesPrepareResponse,
} from "./ses_prepare_docket_revision.ts";
import {
  createSesDocketPersistenceAdapter,
  SES_DOCKET_BUCKET,
} from "./ses_docket_persistence.ts";
import {
  isCurrentCuratedRendererVersion,
  MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256,
  MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION,
  MAKESAFE_REPORT_CONTRACT_VERSION,
} from "./makesafe_report_render.ts";
import {
  renderRoofReportPdf,
  type RoofReportJob,
} from "./roof_report_render.ts";
import { deriveExistingFencePicketDecision } from "./makesafe_existing_fence_pickets.ts";
import { buildRoofReportJob } from "./roof_report_template.ts";
import { isBundledCoverageSendNote } from "./makesafe_send_pack.ts";
import { renderSesSwmsPdf } from "./ses_swms_render.ts";
import {
  inspectSesSupportingReportProof,
  SES_SUPPORTING_REPORT_MAX_BYTES,
  sesSupportingReportDocumentBinding,
} from "./ses_supporting_report_trust.ts";
import {
  canonicalSesPortalCaptureResult,
  canonicalSesPortalCaptureRole,
  canonicalSesPortalSourceUrl,
  isSesPortalCapturePng,
  isSesSha256,
  isTrustedSesPortalCaptureProducer,
  rawSesPortalCaptureSha256,
  SES_PORTAL_CAPTURE_BUCKET,
  type SesPersistedPortalCaptureRow,
  sesPortalCaptureProducerHasScreenshot,
  type SesPortalCaptureRevisionContent,
  sesPortalCaptureRevisionHash,
} from "./ses_portal_capture_contract.ts";

export class SesAssemblerAdapterError extends Error {
  status: number;
  code: string;

  constructor(code: string, message: string, status = 500) {
    super(message);
    this.name = "SesAssemblerAdapterError";
    this.status = status;
    this.code = code;
  }
}

export type SesHttpArtifact = Omit<SesArtifact, "bytes">;
export type SesHttpPreparedRevision =
  & Omit<SesPreparedRevision, "artifacts">
  & { artifacts: SesHttpArtifact[] };
export type SesHttpPrepareResponse =
  & Omit<SesPrepareResponse, "results">
  & { results: SesHttpPreparedRevision[] };

/**
 * The U4 HTTP response is an evidence envelope, not an artifact transport.
 * Raw PDFs and photos remain available to the persistence adapter, while the
 * caller receives their exact paths, hashes, sizes, media types and metadata.
 * Serializing Uint8Array values into JSON expands every byte into a numeric
 * object property and can exhaust the edge worker on a normal photo pack.
 */
export function summarizeSesPrepareResponseForHttp(
  response: SesPrepareResponse,
): SesHttpPrepareResponse {
  return {
    ...response,
    results: response.results.map((result) => ({
      ...result,
      artifacts: result.artifacts.map((artifact) => ({
        role: artifact.role,
        path: artifact.path,
        media_type: artifact.media_type,
        content_hash: artifact.content_hash,
        size_bytes: artifact.size_bytes,
        metadata: artifact.metadata,
      })),
    })),
  };
}

// Supabase rows in this function are intentionally schema-dynamic: production
// and migration-provisioned shapes can differ. Keep that unsafe boundary named
// and local; the emitted assembler contract remains fully typed.
// deno-lint-ignore no-explicit-any
type LiveRow = Record<string, any>;

export interface SesAssemblerLiveSnapshot {
  job: LiveRow;
  detail: LiveRow | null;
  identity_revision?: LiveRow | null;
  cases: LiveRow[];
  cycles: LiveRow[];
  reports: LiveRow[];
  assignments: LiveRow[];
  media: LiveRow[];
  documents: LiveRow[];
  roof_draft: LiveRow | null;
  readiness: LiveRow | null;
  portal_captures: LiveRow[];
  legacy_packs: LiveRow[];
  docket_revisions?: LiveRow[];
  docket_artifacts?: LiveRow[];
  events?: LiveRow[];
  bundle_bindings?: LiveRow[];
  bundle_claims?: LiveRow[];
  bundle_jobs?: LiveRow[];
  bundle_details?: LiveRow[];
  bundle_reports?: LiveRow[];
  bundle_assignments?: LiveRow[];
  bundle_invoices?: LiveRow[];
  bundle_documents?: LiveRow[];
  bundle_emails?: LiveRow[];
  bundle_media?: LiveRow[];
}

type Selection = Exclude<
  SesPrepareRequest["selection"],
  { mode: "board_batch" }
>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): LiveRow {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as LiveRow)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const candidate = text(value);
    if (candidate) return candidate;
  }
  return "";
}

function stringArray(...values: unknown[]): string[] {
  const out = new Set<string>();
  for (const value of values) {
    for (const item of array(value)) {
      const candidate = text(item);
      if (candidate) out.add(candidate);
    }
  }
  return [...out].sort();
}

function legacyBundleCandidate(
  snapshot: SesAssemblerLiveSnapshot,
): {
  suspected_sibling_job_number: string;
  suspected_invoice_number: string | null;
} | null {
  for (const event of snapshot.events || []) {
    const detail = record(event.detail_json);
    const note = firstText(detail.text, detail.note);
    if (!isBundledCoverageSendNote(note)) continue;
    const currentNumber = text(snapshot.job.job_number).toUpperCase();
    const sibling = [...note.matchAll(/\bSWMS-\d+\b/gi)]
      .map((match) => match[0].toUpperCase())
      .find((number) => number !== currentNumber);
    if (!sibling) continue;
    return {
      suspected_sibling_job_number: sibling,
      suspected_invoice_number:
        note.match(/\bINV-?\d{3,}\b/i)?.[0]?.toUpperCase() || null,
    };
  }
  return null;
}

function currentBindingRows(rows: LiveRow[]): LiveRow[] {
  const latest = new Map<string, LiveRow>();
  for (
    const row of rows.slice().sort((left, right) =>
      text(left.recorded_at).localeCompare(text(right.recorded_at)) ||
      text(left.id).localeCompare(text(right.id))
    )
  ) {
    latest.set(
      `${text(row.org_id)}:${text(row.job_id)}:${text(row.sibling_job_id)}`,
      row,
    );
  }
  return [...latest.values()];
}

function phraseCovered(haystack: unknown, phrase: unknown): boolean {
  const needle = text(phrase).toLowerCase();
  return needle.length >= 8 &&
    String(haystack || "").toLowerCase().includes(needle);
}

function lineItemId(row: LiveRow): string {
  return firstText(
    row.LineItemID,
    row.LineItemId,
    row.lineItemID,
    row.line_item_id,
    row.id,
  );
}

function lineItemDescription(row: LiveRow): string {
  return firstText(row.Description, row.description);
}

export function resolveSiblingBundleEvidence(
  snapshot: SesAssemblerLiveSnapshot,
): SesSiblingBundleEvidence | undefined {
  const candidate = legacyBundleCandidate(snapshot);
  const current = currentBindingRows(snapshot.bundle_bindings || []);
  const currentOutbound = current.filter((row) =>
    text(row.job_id) === text(snapshot.job.id) && text(row.state) === "bound"
  );
  const claimedBindingIds = new Set(
    (snapshot.bundle_claims || []).map((row) => text(row.binding_revision_id))
      .filter(Boolean),
  );
  const sharingOutbound = candidate
    ? currentOutbound
    : currentOutbound.filter((row) => claimedBindingIds.has(text(row.id)));
  if (!candidate && sharingOutbound.length === 0) {
    if (currentOutbound.length === 0) return undefined;
    sharingOutbound.push(...currentOutbound);
  }
  if (!candidate && sharingOutbound.length > 1) {
    return {
      status: "scope_evidence_missing",
      suspected_sibling_job_id: null,
      suspected_sibling_job_number: sharingOutbound
        .map((row) =>
          firstText(
            (snapshot.bundle_jobs || []).find((job) =>
              text(job.id) === text(row.sibling_job_id)
            )?.job_number,
            row.sibling_job_id,
          )
        )
        .sort()
        .join(", "),
      suspected_invoice_number: null,
      bundle_id: null,
      binding_revision_id: null,
      reverse_binding_revision_id: null,
      coverage_failures: ["multiple_current_sibling_bindings"],
    };
  }
  const outbound = sharingOutbound.find((row) => (!candidate ||
    (snapshot.bundle_jobs || []).some((job) =>
      text(job.id) === text(row.sibling_job_id) &&
      text(job.job_number).toUpperCase() ===
        candidate.suspected_sibling_job_number
    ))
  );
  const siblingJob = outbound
    ? (snapshot.bundle_jobs || []).find((job) =>
      text(job.id) === text(outbound.sibling_job_id)
    )
    : candidate
    ? (snapshot.bundle_jobs || []).find((job) =>
      text(job.job_number).toUpperCase() ===
        candidate.suspected_sibling_job_number
    )
    : undefined;
  const suspectedSiblingNumber = firstText(
    siblingJob?.job_number,
    candidate?.suspected_sibling_job_number,
  );
  const suspectedSiblingId = firstText(
    siblingJob?.id,
    outbound?.sibling_job_id,
  ) || null;

  if (!outbound) {
    if (!candidate) return undefined;
    return {
      status: "binding_missing",
      suspected_sibling_job_id: suspectedSiblingId,
      suspected_sibling_job_number: suspectedSiblingNumber,
      suspected_invoice_number: candidate.suspected_invoice_number,
      bundle_id: null,
      binding_revision_id: null,
      reverse_binding_revision_id: null,
      coverage_failures: ["claiming_direction_not_bound"],
    };
  }

  const reverse = current.find((row) =>
    text(row.job_id) === text(outbound.sibling_job_id) &&
    text(row.sibling_job_id) === text(outbound.job_id) &&
    text(row.org_id) === text(outbound.org_id) &&
    text(row.bundle_id) === text(outbound.bundle_id) &&
    text(row.state) === "bound"
  );
  if (!reverse) {
    return {
      status: "binding_not_bidirectional",
      suspected_sibling_job_id: suspectedSiblingId,
      suspected_sibling_job_number: suspectedSiblingNumber,
      suspected_invoice_number: candidate?.suspected_invoice_number || null,
      bundle_id: text(outbound.bundle_id),
      binding_revision_id: text(outbound.id),
      reverse_binding_revision_id: null,
      coverage_failures: ["reverse_direction_not_bound"],
    };
  }

  const failures: string[] = [];
  const claim = (snapshot.bundle_claims || []).find((row) =>
    text(row.binding_revision_id) === text(outbound.id)
  );
  if (!claim) failures.push("positive_scope_claim_missing");
  const invoice = claim
    ? (snapshot.bundle_invoices || []).find((row) =>
      text(row.id) === text(claim.invoice_id) &&
      text(row.job_id) === text(outbound.sibling_job_id)
    )
    : undefined;
  if (!invoice) failures.push("sibling_invoice_missing");
  if (
    invoice &&
    !["AUTHORISED", "PAID"].includes(text(invoice.status).toUpperCase())
  ) {
    failures.push("sibling_invoice_not_authorised");
  }
  const invoiceLine = invoice && claim
    ? array(invoice.line_items).map(record).find((row) =>
      lineItemId(row) === text(claim.invoice_line_item_id)
    )
    : undefined;
  if (!invoiceLine) failures.push("invoice_line_missing");
  if (
    invoiceLine && claim &&
    !phraseCovered(
      lineItemDescription(invoiceLine),
      claim.invoice_scope_phrase,
    )
  ) {
    failures.push("invoice_line_scope_not_covered");
  }
  const email = claim
    ? (snapshot.bundle_emails || []).find((row) =>
      text(row.post_id) === text(claim.delivery_email_post_id)
    )
    : undefined;
  if (!email) failures.push("delivery_email_missing");
  if (
    email &&
    (text(email.content_sha256) !==
        text(claim?.delivery_email_content_sha256) ||
      email.has_attachments !== true)
  ) {
    failures.push("delivery_email_identity_mismatch");
  }
  if (
    email && claim &&
    !phraseCovered(
      `${firstText(email.subject)} ${firstText(email.body_preview)}`,
      claim.delivery_scope_phrase,
    )
  ) {
    failures.push("delivery_scope_not_covered");
  }
  if (
    email && claim &&
    !phraseCovered(
      `${firstText(email.subject)} ${firstText(email.body_preview)}`,
      claim.photo_scope_phrase,
    )
  ) {
    failures.push("photo_scope_not_covered");
  }
  if (claim && !text(claim.photo_scope_phrase)) {
    failures.push("photo_scope_claim_missing");
  }
  const photo = claim
    ? (snapshot.bundle_media || []).find((row) =>
      text(row.id) === text(claim.photo_media_id) &&
      text(row.job_id) === text(outbound.sibling_job_id) &&
      text(row.type).toLowerCase() === "photo"
    )
    : undefined;
  if (!photo) failures.push("sibling_photo_artifact_missing");
  if (
    photo && claim &&
    (text(photo.makesafe_content_hash) !== text(claim.photo_content_hash) ||
      !/^sha256:[0-9a-f]{64}$/.test(text(claim.photo_content_hash)))
  ) {
    failures.push("sibling_photo_artifact_hash_mismatch");
  }
  if (
    photo && claim &&
    !phraseCovered(
      `${firstText(photo.label)} ${firstText(photo.notes)}`,
      claim.photo_scope_phrase,
    )
  ) {
    failures.push("photo_artifact_scope_not_covered");
  }
  const documents = snapshot.bundle_documents || [];
  const report = claim
    ? documents.find((row) =>
      text(row.id) === text(claim.report_document_id) &&
      text(row.job_id) === text(outbound.sibling_job_id) &&
      ["report", "makesafe_report"].includes(text(row.type).toLowerCase())
    )
    : undefined;
  if (!report) failures.push("sibling_report_missing");
  const swms = claim
    ? documents.find((row) =>
      text(row.id) === text(claim.swms_document_id) &&
      text(row.job_id) === text(outbound.sibling_job_id) &&
      text(row.type).toLowerCase() === "swms"
    )
    : undefined;
  if (!swms) failures.push("sibling_swms_missing");
  if (
    !text(outbound.recorded_by) || !text(outbound.recorded_via) ||
    !Object.keys(record(outbound.provenance)).length ||
    !text(reverse.recorded_by) || !text(reverse.recorded_via) ||
    !Object.keys(record(reverse.provenance)).length
  ) {
    failures.push("binding_provenance_missing");
  }

  if (failures.length || !claim || !invoice || !email || !report || !swms) {
    return {
      status: "scope_evidence_missing",
      suspected_sibling_job_id: suspectedSiblingId,
      suspected_sibling_job_number: suspectedSiblingNumber,
      suspected_invoice_number: firstText(
        invoice?.invoice_number,
        candidate?.suspected_invoice_number,
      ) || null,
      bundle_id: text(outbound.bundle_id),
      binding_revision_id: text(outbound.id),
      reverse_binding_revision_id: text(reverse.id),
      coverage_failures: [...new Set(failures)].sort(),
    };
  }

  return {
    status: "accepted",
    bundle_id: text(outbound.bundle_id),
    claiming_binding: {
      revision_id: text(outbound.id),
      recorded_by: text(outbound.recorded_by),
      recorded_via: text(outbound.recorded_via),
      provenance: record(outbound.provenance),
    },
    reverse_binding: {
      revision_id: text(reverse.id),
      recorded_by: text(reverse.recorded_by),
      recorded_via: text(reverse.recorded_via),
      provenance: record(reverse.provenance),
    },
    sibling: {
      job_id: text(outbound.sibling_job_id),
      job_number: suspectedSiblingNumber,
    },
    coverage: {
      invoice: {
        invoice_id: text(invoice.id),
        invoice_number: text(invoice.invoice_number),
        line_item_id: text(claim.invoice_line_item_id),
        scope_phrase: text(claim.invoice_scope_phrase),
      },
      delivery: {
        email_post_id: text(email.post_id),
        content_sha256: text(email.content_sha256),
        scope_phrase: text(claim.delivery_scope_phrase),
      },
      photo: {
        email_post_id: text(email.post_id),
        content_sha256: text(email.content_sha256),
        scope_phrase: text(claim.photo_scope_phrase),
        media_id: text(photo!.id),
        content_hash: text(claim.photo_content_hash) as SesSha256,
      },
      report_document_id: text(report.id),
      swms_document_id: text(swms.id),
    },
  };
}

function hasExplicitValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "boolean";
}

function canonicalFactKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function canonicalFactValue(value: unknown): string {
  return typeof value === "string"
    ? `string:${value.trim().toLowerCase()}`
    : `${typeof value}:${String(value)}`;
}

function structuredSourceFact(
  snapshot: SesAssemblerLiveSnapshot,
  intakeCase: LiveRow | null,
  aliases: readonly string[],
): unknown {
  const acceptedKeys = new Set(aliases.map(canonicalFactKey));
  const roots = [
    snapshot.job.scope_json,
    snapshot.detail?.scope_json,
    intakeCase?.raw_identity_json,
    snapshot.job.metadata,
  ];
  const matches: unknown[] = [];
  for (const root of roots) {
    const queue: Array<{ value: unknown; depth: number }> = [{
      value: root,
      depth: 0,
    }];
    let visited = 0;
    while (queue.length && visited < 1_000) {
      const current = queue.shift()!;
      visited++;
      if (
        !current.value ||
        typeof current.value !== "object" ||
        Array.isArray(current.value) ||
        current.depth > 6
      ) {
        continue;
      }
      for (const [key, value] of Object.entries(record(current.value))) {
        if (
          acceptedKeys.has(canonicalFactKey(key)) && hasExplicitValue(value)
        ) {
          matches.push(value);
        }
        if (
          value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          current.depth < 6
        ) {
          queue.push({ value, depth: current.depth + 1 });
        }
      }
    }
  }
  const distinct = new Map(
    matches.map((value) => [canonicalFactValue(value), value]),
  );
  return distinct.size === 1 ? [...distinct.values()][0] : undefined;
}

function builderKey(snapshot: SesAssemblerLiveSnapshot): SesBuilderKey {
  const detail = snapshot.detail || {};
  const company = record(detail.makesafe_companies);
  const profileSlugs = [
    detail.requesting_company_slug,
    company.slug,
  ].map((value) => text(value).toLowerCase()).filter(Boolean);
  if (profileSlugs.includes("synthetic-livefire")) return "SYNTHETIC";
  const token = [
    detail.requesting_company_slug,
    detail.requesting_company_name,
    company.slug,
    company.name,
    detail.external_ref,
    snapshot.job.metadata?.requesting_company?.slug,
    snapshot.job.metadata?.requesting_company?.name,
  ]
    .map((value) => text(value).toLowerCase())
    .join(" ");
  if (/\bajbr\b/.test(token)) return "AJBR";
  if (/\bajs?\b/.test(token) || token.includes("alliance joinery")) {
    return "AJS";
  }
  if (
    /\b(mlb|ml builders?|major loss builders?)\b/.test(token) ||
    token.includes("mlbuilders")
  ) {
    return "MLB";
  }
  if (
    /\b(wb|bw|bwcwa)\b/.test(token) ||
    token.includes("western build") ||
    token.includes("builderwest")
  ) {
    return "WESTERN";
  }
  return "UNKNOWN";
}

function family(snapshot: SesAssemblerLiveSnapshot): SesFamilyId {
  const metadata = record(snapshot.job.metadata);
  return canonicalSesFamilyFromCard({
    makesafe_job_family: metadata.makesafe_job_family,
    insurance_job_type: metadata.insurance_job_type,
    own_template_requested: metadata.own_template_requested,
    strata: metadata.strata,
    report_delivery: metadata.report_delivery ||
      snapshot.detail?.report_delivery,
  });
}

export interface SesDeliveryRenderRouteSelection {
  route: SesDeliveryRenderRoute;
  reason_code: string;
  reason: string;
  evidence: string[];
}

function clientRelationshipMarker(value: unknown): string | null {
  const candidate = text(value).toLowerCase();
  if (/\bstrata\b/.test(candidate)) return "strata";
  if (/\bowners?\s+corporation\b/.test(candidate)) {
    return "owners_corporation";
  }
  if (/\bbody\s+corporate\b/.test(candidate)) return "body_corporate";
  return null;
}

export function resolveSesDeliveryRenderRoute(
  snapshot: SesAssemblerLiveSnapshot,
  builder: SesBuilderKey,
  familyId: SesFamilyId,
): SesDeliveryRenderRouteSelection {
  if (familyId === "assessment_quote") {
    return {
      route: "builder_portal",
      reason_code: "assessment_portal_recipe",
      reason:
        "The sealed assessment recipe is delivered through the builder portal.",
      evidence: [`builder-family:${builder}/${familyId}`],
    };
  }
  if (
    familyId !== "ordinary_roof_portal" &&
    familyId !== "own_template_roof"
  ) {
    return {
      route: "not_applicable",
      reason_code: "non_roof_family",
      reason: `Family ${familyId} has no roof delivery/render route.`,
      evidence: [`builder-family:${builder}/${familyId}`],
    };
  }

  const metadata = record(snapshot.job.metadata);
  const detail = snapshot.detail || {};
  const modeFacts = [
    ["makesafe_job_details.roof_report_mode", detail.roof_report_mode],
    ["jobs.metadata.roof_report_mode", metadata.roof_report_mode],
    [
      "jobs.metadata.makesafe_roof_report_mode",
      metadata.makesafe_roof_report_mode,
    ],
  ]
    .map(([field, value]) => [field, text(value).toLowerCase()] as const)
    .filter(([, value]) => value);
  const modeValues = [...new Set(modeFacts.map(([, value]) => value))];
  if (modeValues.length > 1) {
    return {
      route: "unroutable",
      reason_code: "conflicting_roof_delivery_facts",
      reason:
        "Persisted card facts disagree about the roof delivery/render mode.",
      evidence: modeFacts.map(([field, value]) => `${field}=${value}`).sort(),
    };
  }
  const explicitMode = modeValues[0] || "";
  const metadataReportDelivery = text(metadata.report_delivery).toLowerCase();
  const detailReportDelivery = text(detail.report_delivery).toLowerCase();
  for (
    const [field, value] of [
      ["jobs.metadata.report_delivery", metadataReportDelivery],
      ["makesafe_job_details.report_delivery", detailReportDelivery],
    ] as const
  ) {
    if (value && value !== "portal" && value !== "own_document") {
      return {
        route: "unroutable",
        reason_code: "delivery_route_unroutable",
        reason:
          `Persisted ${field} value "${value}" is not a sealed roof delivery route.`,
        evidence: [`${field}=${value}`],
      };
    }
  }
  if (
    metadataReportDelivery &&
    detailReportDelivery &&
    metadataReportDelivery !== detailReportDelivery
  ) {
    return {
      route: "unroutable",
      reason_code: "conflicting_roof_delivery_facts",
      reason:
        "Persisted card facts disagree about portal versus SecureWorks own-letterhead delivery.",
      evidence: [
        `jobs.metadata.report_delivery=${metadataReportDelivery}`,
        `makesafe_job_details.report_delivery=${detailReportDelivery}`,
      ].sort(),
    };
  }
  const reportDelivery = metadataReportDelivery || detailReportDelivery;
  const relationship = clientRelationshipMarker(snapshot.job.client_name);
  const ownEvidence = [
    familyId === "own_template_roof"
      ? "canonical-family:own_template_roof"
      : "",
    metadata.own_template_requested === true
      ? "jobs.metadata.own_template_requested=true"
      : "",
    metadata.strata === true ? "jobs.metadata.strata=true" : "",
    reportDelivery === "own_document"
      ? "card.report_delivery=own_document"
      : "",
    explicitMode === "own_template" ? "card.roof_report_mode=own_template" : "",
    snapshot.roof_draft ? "makesafe_roof_report_drafts=current" : "",
    relationship ? `jobs.client_name#relationship:${relationship}` : "",
  ].filter(Boolean);
  const portalEvidence = [
    reportDelivery === "portal" ? "card.report_delivery=portal" : "",
    explicitMode === "builder_portal"
      ? "card.roof_report_mode=builder_portal"
      : "",
  ].filter(Boolean);

  if (
    explicitMode &&
    explicitMode !== "own_template" &&
    explicitMode !== "builder_portal"
  ) {
    return {
      route: "unroutable",
      reason_code: "invalid_explicit_roof_report_mode",
      reason:
        `Persisted roof_report_mode "${explicitMode}" is not a sealed delivery/render route.`,
      evidence: [`card.roof_report_mode=${explicitMode}`],
    };
  }
  if (ownEvidence.length && portalEvidence.length) {
    return {
      route: "unroutable",
      reason_code: "conflicting_roof_delivery_facts",
      reason:
        "Persisted card facts require both portal and SecureWorks own-letterhead delivery.",
      evidence: [...ownEvidence, ...portalEvidence].sort(),
    };
  }
  if (ownEvidence.length) {
    if (builder !== "MLB") {
      return {
        route: "unroutable",
        reason_code: "own_letterhead_builder_family_unsealed",
        reason:
          `Builder ${builder} has no sealed own-letterhead roof delivery/render route.`,
        evidence: ownEvidence.sort(),
      };
    }
    return {
      route: "secureworks_own_letterhead",
      reason_code: relationship
        ? "client_relationship_requires_own_letterhead"
        : snapshot.roof_draft
        ? "existing_own_letterhead_draft"
        : "explicit_own_letterhead_route",
      reason: relationship
        ? `The persisted ${
          relationship.replaceAll("_", " ")
        } client relationship requires SecureWorks Group letterhead.`
        : snapshot.roof_draft
        ? "The card has an existing SecureWorks own-letterhead roof draft."
        : "The card explicitly requires SecureWorks Group own-letterhead delivery.",
      evidence: ownEvidence.sort(),
    };
  }
  if (builder === "MLB" || builder === "SYNTHETIC") {
    return {
      route: "builder_portal",
      reason_code: portalEvidence.length
        ? "explicit_builder_portal_route"
        : "portal_builder_family",
      reason: portalEvidence.length
        ? "The card explicitly requires the builder portal route."
        : `Builder ${builder} uses the sealed portal route for ordinary roof reports.`,
      evidence: (
        portalEvidence.length
          ? portalEvidence
          : [`builder-family:${builder}/${familyId}`]
      ).sort(),
    };
  }
  return {
    route: "unroutable",
    reason_code: "roof_builder_family_unsealed",
    reason:
      `Builder ${builder} has no sealed portal or own-letterhead roof delivery/render route.`,
    evidence: [`builder-family:${builder}/${familyId}`],
  };
}

function lineageKind(relation: unknown): "none" | "revision" | "sibling" {
  const value = text(relation);
  if (value === "sibling_of") return "sibling";
  if (value) return "revision";
  return "none";
}

function workflow(
  intakeCase: LiveRow | null,
): "active" | "cancellation" | "revision" | "no_access" {
  const reason = text(intakeCase?.reason_code);
  const relation = text(intakeCase?.parent_relation);
  if (reason === "cancellation" || relation === "cancellation_of") {
    return "cancellation";
  }
  if (reason === "revision" || relation === "revision_of") return "revision";
  if (
    array(intakeCase?.blocked_reasons).some((item) =>
      text(item).toLowerCase().includes("no_access")
    )
  ) {
    return "no_access";
  }
  return "active";
}

function sourceCase(cases: LiveRow[]): LiveRow | null {
  const live = cases.filter((item) =>
    ["confirmed_live_job", "blocked_live_job"].includes(text(item.state))
  );
  return live.length === 1 ? live[0] : null;
}

function portalRole(
  familyId: SesFamilyId,
  rawRole: string,
  hasTypedRoofReport: boolean,
):
  | "roof_report"
  | "assessment"
  | "photos"
  | "scope"
  | "builder_portal"
  | "other" {
  const role = rawRole.toLowerCase();
  // Persisted explicit role is candidate evidence. Never erase an assessment
  // triad merely because the current card is a roof card: that was the earliest
  // divergence that turned one typed roof URL into four apparent roof rivals.
  if (role === "roof_report") return "roof_report";
  if (role === "assessment_report") return "assessment";
  if (role === "photos") return "photos";
  if (role === "scope" || role === "quote") return "scope";
  if (role === "builder_portal") {
    // Legacy roof cards often have one genuinely generic share link. Preserve
    // that fallback only when no explicit roof_report candidate exists; typed
    // evidence always outranks generic inventory and ties remain fail-closed.
    if (familyId === "ordinary_roof_portal" && !hasTypedRoofReport) {
      return "roof_report";
    }
    return "builder_portal";
  }
  return "other";
}

function explicitHoursAndMaterials(
  snapshot: SesAssemblerLiveSnapshot,
  currentReport: LiveRow | null,
  intakeCase: LiveRow | null,
  classification: {
    builder: SesBuilderKey;
    family: SesFamilyId;
    attendanceCycleId: string;
  },
): Record<string, unknown> | null {
  const checklist = record(currentReport?.checklist_json);
  const completion = record(checklist.completion);
  const pricing = record(checklist.pricing);
  const roofFields = record(snapshot.roof_draft?.fields_json);
  const facts: Record<string, unknown> = {};
  const copy = (key: string, ...values: unknown[]) => {
    for (const value of values) {
      if (hasExplicitValue(value)) {
        facts[key] = value;
        return;
      }
    }
  };
  copy(
    "storeys",
    structuredSourceFact(snapshot, intakeCase, [
      "storeys",
      "storey",
      "number_of_storeys",
      "numberOfStoreys",
      "storey_count",
      "storeyCount",
    ]),
    snapshot.roof_draft?.storey,
    roofFields.storeys,
  );
  copy(
    "trades",
    pricing.trades,
    completion.trades,
    checklist.trades,
    checklist.trade_count,
  );
  // The sealed reporting skill defines labour_hours as hours for each trade,
  // paired with trade_count. The live submit path writes exactly that pair.
  copy(
    "hours_per_trade",
    pricing.hours_per_trade,
    completion.hours_per_trade,
    checklist.hours_per_trade,
    checklist.labour_hours,
  );
  copy("rate_ex_gst", pricing.rate_ex_gst, checklist.rate_ex_gst);
  copy(
    "panel_count",
    pricing.panel_count,
    checklist.panel_count,
    structuredSourceFact(snapshot, intakeCase, [
      "panel_count",
      "panelCount",
      "temporary_fence_panel_count",
      "temp_fence_panel_count",
      "number_of_panels",
      "numberOfPanels",
    ]),
  );
  copy(
    "base_count",
    pricing.base_count,
    checklist.base_count,
    structuredSourceFact(snapshot, intakeCase, [
      "base_count",
      "baseCount",
      "block_count",
      "blockCount",
      "number_of_bases",
      "numberOfBases",
      "number_of_blocks",
      "numberOfBlocks",
    ]),
  );
  copy(
    "star_picket_count",
    pricing.star_picket_count,
    checklist.star_picket_count,
    structuredSourceFact(snapshot, intakeCase, [
      "star_picket_count",
      "starPicketCount",
      "picket_count",
      "picketCount",
      "number_of_star_pickets",
      "numberOfStarPickets",
    ]),
  );
  if (typeof pricing.fence_only === "boolean") {
    facts.fence_only = pricing.fence_only;
  } else if (typeof checklist.fence_only === "boolean") {
    facts.fence_only = checklist.fence_only;
  } else {
    const fenceOnly = structuredSourceFact(snapshot, intakeCase, [
      "fence_only",
      "fenceOnly",
      "is_fence_only",
      "isFenceOnly",
      "assessment_fence_only",
      "assessmentFenceOnly",
    ]);
    if (typeof fenceOnly === "boolean") facts.fence_only = fenceOnly;
  }
  const materials = array(pricing.materials).length
    ? array(pricing.materials)
    : array(checklist.materials);
  if (materials.length) facts.materials = materials;
  if (
    (classification.builder === "AJS" ||
      classification.builder === "AJBR") &&
    classification.family === "physical_makesafe"
  ) {
    const panelCount = Number(facts.panel_count);
    const baseCount = Number(facts.base_count);
    const structuredKitSignals = [
      Number.isFinite(panelCount) && panelCount > 0
        ? `Panels x ${String(facts.panel_count)}`
        : "",
      Number.isFinite(baseCount) && baseCount > 0
        ? `Bases x ${String(facts.base_count)}`
        : "",
    ].filter(Boolean);
    const pickets = deriveExistingFencePicketDecision({
      support_narratives: [
        ...currentCuratedReportScopeNarratives(
          snapshot,
          classification.attendanceCycleId,
        ),
      ],
      materials_used: checklist.materials_used,
      charged_line_descriptions: [
        ...structuredKitSignals,
        ...materials.map((material) => record(material).description),
      ],
    });
    if (pickets.state === "billable") {
      facts.existing_fence_star_picket_count = pickets.quantity;
      facts.existing_fence_star_picket_evidence = {
        source: "job_service_reports.checklist_json.materials_used",
        report_id: currentReport?.id ?? null,
      };
    } else if (pickets.state === "refused") {
      facts.existing_fence_star_picket_refusal = pickets.reason;
    }
  }
  return Object.keys(facts).length ? facts : null;
}

/** The name on the user record joined to THIS assignment row.
 *
 * The board already resolves crew this way (`makesafeCrew`, index.ts): it prefers
 * `assignment.crew_name` and falls back to the joined `users.name`. U4 only ever read
 * `crew_name`, so a job whose crew is recorded solely as an assigned user looked crewless to the
 * SWMS generator while the board displayed the name. This closes that plumbing gap.
 *
 * It reads one field off the row it was handed and nothing else: no lookup by name, no default,
 * no carry-over from another card, and no inference when the join is absent.
 */
function assignedUserName(assignment: LiveRow): string | null {
  const joined = assignment.users;
  if (!joined || typeof joined !== "object") return null;
  // PostgREST returns an object for a to-one embed and an array for a to-many shape.
  const row = Array.isArray(joined) ? joined[0] : joined;
  if (!row || typeof row !== "object") return null;
  return text((row as Record<string, unknown>).name) || null;
}

function currentAssignment(
  assignments: LiveRow[],
  detail: LiveRow,
  attendanceCycleId: string | null,
): LiveRow | null {
  const current = filterAssignmentsForCurrentCycle(
    assignments,
    detail,
    attendanceCycleId,
  ).assignments.map(record);
  return current.slice().sort((left, right) =>
    firstText(
      right.arrived_at,
      right.scheduled_date,
      right.updated_at,
      right.created_at,
    ).localeCompare(
      firstText(
        left.arrived_at,
        left.scheduled_date,
        left.updated_at,
        left.created_at,
      ),
    ) || text(right.id).localeCompare(text(left.id))
  )[0] || null;
}

function swmsTradeReport(row: LiveRow): Record<string, unknown> {
  return {
    id: row.id ?? null,
    status: row.status ?? null,
    submitted_at: row.submitted_at ?? null,
    checklist_json: row.checklist_json ?? {},
    notes: row.notes ?? null,
  };
}

function swmsFactContext(
  snapshot: SesAssemblerLiveSnapshot,
  localReport: LiveRow | null,
  localCycleId: string,
  siblingBundleEvidence: SesSiblingBundleEvidence | undefined,
): SesAssemblerInputV1["cycle_facts"]["swms_fact_context"] {
  if (localReport) {
    const assignment = currentAssignment(
      snapshot.assignments,
      snapshot.detail || {},
      localCycleId || null,
    );
    return {
      evidence_kind: "current_card",
      evidence_job_id: text(snapshot.job.id),
      evidence_job_number: text(snapshot.job.job_number) || null,
      trade_report: null,
      job_client_name: text(snapshot.job.client_name) || null,
      assignment: assignment
        ? {
          id: text(assignment.id) || null,
          crew_name: text(assignment.crew_name) || null,
          assigned_user_name: assignedUserName(assignment),
          scheduled_date: text(assignment.scheduled_date) || null,
          arrived_at: text(assignment.arrived_at) || null,
        }
        : null,
    };
  }
  if (!siblingBundleEvidence || siblingBundleEvidence.status !== "accepted") {
    return null;
  }
  const siblingId = siblingBundleEvidence.sibling.job_id;
  const siblingJob = (snapshot.bundle_jobs || []).find((row) =>
    text(row.id) === siblingId
  );
  const siblingDetail =
    (snapshot.bundle_details || []).find((row) =>
      text(row.job_id) === siblingId
    ) || {};
  const siblingCycleId = text(siblingDetail.attendance_cycle_id);
  const siblingReport = selectCurrentCycleReport(
    (snapshot.bundle_reports || []).filter((row) =>
      text(row.job_id) === siblingId
    ),
    siblingDetail,
    siblingCycleId || null,
  );
  if (!siblingReport) return null;
  const assignment = currentAssignment(
    (snapshot.bundle_assignments || []).filter((row) =>
      text(row.job_id) === siblingId
    ),
    siblingDetail,
    siblingCycleId || null,
  );
  return {
    evidence_kind: "sibling_bundle",
    evidence_job_id: siblingId,
    evidence_job_number: siblingBundleEvidence.sibling.job_number,
    trade_report: swmsTradeReport(record(siblingReport)),
    job_client_name: text(siblingJob?.client_name) || null,
    assignment: assignment
      ? {
        id: text(assignment.id) || null,
        crew_name: text(assignment.crew_name) || null,
        assigned_user_name: assignedUserName(assignment),
        scheduled_date: text(assignment.scheduled_date) || null,
        arrived_at: text(assignment.arrived_at) || null,
      }
      : null,
  };
}

export function physicalReportRenderJob(
  _snapshot: SesAssemblerLiveSnapshot,
  _input: SesAssemblerInputV1,
  _photoArtifacts: SesPhotoArtifact[] = [],
): never {
  throw new SesAssemblerAdapterError(
    "ses_curated_report_missing",
    "Raw trade-report fields are immutable evidence, not curated builder-report prose; recover an exact current-cycle curated makesafe_report artifact instead.",
    409,
  );
}

function currentCycle(snapshot: SesAssemblerLiveSnapshot): {
  ids: string[];
  id: string;
  number: number;
  attribution: "bound" | "backfill_cycle_scope" | "legacy_unscoped";
} {
  const detail = snapshot.detail || {};
  const ids = snapshot.cycles
    .map((item) => text(item.id))
    .filter(Boolean)
    .sort();
  const id = text(detail.attendance_cycle_id);
  const attribution = text(detail.cycle_attribution);
  return {
    ids,
    id,
    number: currentCycleNumber(detail),
    attribution: attribution === "bound"
      ? "bound"
      : attribution === "backfill_cycle_scope"
      ? "backfill_cycle_scope"
      : "legacy_unscoped",
  };
}

export function buildSesAssemblerInput(
  snapshot: SesAssemblerLiveSnapshot,
): SesAssemblerInputV1 {
  const job = snapshot.job;
  const detail = snapshot.detail || {};
  const metadata = record(job.metadata);
  const company = record(detail.makesafe_companies);
  const intakeCase = sourceCase(snapshot.cases);
  // An unresolved revision is a durable record of ambiguity, not authority to
  // borrow an arbitrary source. Keep U4 fail-closed until that ambiguity is
  // resolved; legacy_job_record is deliberately usable because its evidence
  // refs bind the existing card, detail and work-order document.
  const identityRevision =
    snapshot.identity_revision?.authority_kind === "unresolved_authority"
      ? null
      : snapshot.identity_revision || null;
  const builder = builderKey(snapshot);
  const canonicalFamilyId = family(snapshot);
  const deliveryRoute = resolveSesDeliveryRenderRoute(
    snapshot,
    builder,
    canonicalFamilyId,
  );
  const familyId = deliveryRoute.route === "secureworks_own_letterhead"
    ? "own_template_roof"
    : deliveryRoute.route === "builder_portal" &&
        canonicalFamilyId === "own_template_roof"
    ? "ordinary_roof_portal"
    : canonicalFamilyId;
  const cycle = currentCycle(snapshot);
  const report = selectCurrentCycleReport(
    snapshot.reports,
    detail,
    cycle.id || null,
  );
  const currentMedia = filterMediaForCurrentCycle(
    snapshot.media,
    detail,
    cycle.id || null,
  );
  const workOrders = snapshot.documents.filter((item) =>
    ["work_order", "workorder", "wo"].includes(text(item.type).toLowerCase())
  );
  const matrix = resolveSesFamilyMatrixRow({
    builder_key: builder,
    family: familyId,
    strata: familyId === "own_template_roof",
    own_template_requested: familyId === "own_template_roof",
    site_suburb: firstText(intakeCase?.site_suburb, job.site_suburb),
  });
  // The sealed matrix owns these classification fields. Keeping a parallel
  // family switch here allowed MLB assessment inputs to say delivery=null while
  // the matrix required portal delivery, which U4 correctly rejected.
  const reportOnly = matrix.ok ? matrix.row.report_only : [
    "ordinary_roof_portal",
    "own_template_roof",
    "assessment_quote",
  ].includes(familyId);
  const reportDelivery = matrix.ok
    ? matrix.row.report_delivery
    : familyId === "ordinary_roof_portal"
    ? "portal"
    : familyId === "own_template_roof"
    ? "own_document"
    : null;
  const subtype = matrix.ok
    ? matrix.row.subtype
    : familyId === "temporary_fencing"
    ? "temporary_fencing"
    : null;
  const builderReference = firstText(
    intakeCase?.builder_wo_canonical,
    intakeCase?.builder_po_canonical,
    intakeCase?.external_ref_canonical,
    identityRevision?.authority_kind === "legacy_job_record"
      ? detail.external_ref
      : null,
    identityRevision?.authority_kind === "legacy_job_record"
      ? metadata.external_ref
      : null,
  );
  const extractedPortalLinks = extractPortalLinks(detail.external_links);
  const hasTypedRoofReport = extractedPortalLinks.some((link) =>
    link.role === "roof_report"
  );
  const portalLinks = extractedPortalLinks.map((link) => ({
    role: portalRole(familyId, link.role, hasTypedRoofReport),
    url: link.url,
    source: "job_detail" as const,
  }));
  const photos = currentMedia
    .filter((item) => {
      const type = text(item.type).toLowerCase();
      const phase = text(item.phase).toLowerCase();
      return (
        type.includes("photo") ||
        type.includes("image") ||
        phase.includes("completion") ||
        phase.includes("after")
      );
    })
    .sort(
      (left, right) =>
        Number(left.sort_order ?? left.order_index ?? 0) -
          Number(right.sort_order ?? right.order_index ?? 0) ||
        text(left.id).localeCompare(text(right.id)),
    )
    .map((item, index) => ({
      id: text(item.id),
      path_or_key: `job_media:${text(item.id)}`,
      ...(text(item.label || item.caption)
        ? { caption: text(item.label || item.caption) }
        : {}),
      order: index + 1,
    }));
  const roofFields = record(snapshot.roof_draft?.fields_json);
  const hazardTerms = stringArray(
    metadata.hrcw_source_hazard_terms,
    intakeCase?.raw_identity_json?.hrcw_source_hazard_terms,
  );
  const categories = stringArray(
    metadata.hrcw_categories,
    intakeCase?.raw_identity_json?.hrcw_categories,
  ).filter((item) =>
    [
      "asbestos",
      "work_at_height",
      "structural",
      "other_registered_hrcw",
    ].includes(item)
  ) as SesAssemblerInputV1["hrcw"]["categories"];
  const sourceVersion = (intakeCase?.source_version ??
      identityRevision?.source_version) == null
    ? ""
    : String(
      intakeCase?.source_version ?? identityRevision?.source_version,
    );
  const sourceHash = firstText(
    intakeCase?.source_content_hash,
    identityRevision?.source_content_hash,
  ) as SesSha256;
  const lineageId = firstText(
    intakeCase?.lineage_id,
    identityRevision?.lineage_id,
  );
  const reportTo = firstText(company.report_recipient);
  const invoiceTo = matrix.ok ? matrix.row.invoice_to : null;
  const priorPack = snapshot.legacy_packs.find(
    (item) => text(item.status).toLowerCase() === "sent",
  );
  const siblingBundleEvidence = resolveSiblingBundleEvidence(snapshot);

  return {
    contract_version: SES_INPUT_CONTRACT_VERSION,
    identity: {
      source_instruction_id: firstText(
        intakeCase?.instruction_key,
        identityRevision?.source_instruction_id,
      ),
      source_version: sourceVersion,
      source_content_hash: sourceHash,
      lineage_id: lineageId,
      case_id: firstText(
        intakeCase?.id,
        identityRevision?.effective_case_id,
      ) || null,
      job_id: text(job.id),
      job_number: text(job.job_number) || null,
      card_id: text(job.id) || null,
      property_id: firstText(metadata.property_id) || null,
    },
    attendance: {
      attendance_cycle_ids: cycle.ids,
      current_attendance_cycle_id: cycle.id,
      cycle_number: cycle.number,
      attribution: cycle.attribution,
    },
    classification: {
      builder_key: builder,
      builder_label: firstText(
        detail.requesting_company_name,
        company.name,
        builder,
      ),
      family: familyId,
      subtype,
      report_only: reportOnly,
      report_delivery: reportDelivery,
      delivery_render_route: deliveryRoute.route,
      delivery_render_route_reason_code: deliveryRoute.reason_code,
      delivery_render_route_reason: deliveryRoute.reason,
      delivery_render_route_evidence: deliveryRoute.evidence,
      strata: familyId === "own_template_roof",
      own_template_requested: familyId === "own_template_roof",
      workflow: workflow(intakeCase),
      lineage_kind: lineageKind(intakeCase?.parent_relation),
      family_matrix_version: SES_FAMILY_MATRIX_VERSION,
      assessment_outbound_recipe_version: familyId === "assessment_quote"
        ? SES_ASSESSMENT_RECIPE_VERSION
        : null,
    },
    source: {
      work_order_sender: reportTo || null,
      builder_reference: builderReference,
      po_or_external_ref: firstText(
        intakeCase?.builder_po_canonical,
        intakeCase?.external_ref_canonical,
      ) || null,
      site_address: firstText(intakeCase?.site_address, job.site_address) ||
        null,
      site_suburb: firstText(intakeCase?.site_suburb, job.site_suburb) || null,
      instruction_text: firstText(
        intakeCase?.raw_identity_json?.instruction_text,
        intakeCase?.raw_identity_json?.scope,
      ) || null,
      deliverables: [
        {
          id: firstText(
            intakeCase?.deliverable_ref_canonical,
            identityRevision && workOrders.length
              ? `job_document:${text(workOrders[0].id)}`
              : null,
          ),
          kind: familyId,
        },
      ].filter((item) => item.id),
      attachment_pointers: workOrders
        .map((item) => `job_document:${text(item.id)}`)
        .filter((item) => !item.endsWith(":"))
        .sort(),
      portal_links: portalLinks,
    },
    cycle_facts: {
      trade_report: reportOnly ? null : report
        ? {
          id: report.id ?? null,
          status: report.status ?? null,
          submitted_at: report.submitted_at ?? null,
          checklist_json: report.checklist_json ?? {},
          notes: report.notes ?? null,
        }
        : null,
      photos: reportOnly ? [] : photos,
      roof_report_fields:
        familyId === "own_template_roof" && Object.keys(roofFields).length
          ? roofFields
          : null,
      hours_and_materials: explicitHoursAndMaterials(
        snapshot,
        report,
        intakeCase,
        { builder, family: familyId, attendanceCycleId: cycle.id },
      ),
      swms_fact_context: swmsFactContext(
        snapshot,
        reportOnly ? null : report,
        cycle.id,
        siblingBundleEvidence,
      ),
      prior_release: {
        released: !!priorPack,
        release_revision_id: text(priorPack?.id) || null,
        cycle_set_hash: text(priorPack?.makesafe_content_hash) || null,
      },
    },
    ...(siblingBundleEvidence
      ? { sibling_bundle_evidence: siblingBundleEvidence }
      : {}),
    hrcw: {
      hrcw: metadata.hrcw === true ||
        intakeCase?.raw_identity_json?.hrcw === true ||
        categories.length > 0 ||
        hazardTerms.length > 0,
      categories,
      source_hazard_terms: hazardTerms,
    },
    routing_seed: {
      report_to: reportTo || null,
      invoice_to: invoiceTo,
    },
    readiness: {
      readiness_revision: (text(snapshot.readiness?.readiness_revision) ||
        null) as SesSha256 | null,
      dependency_generation: Number.isFinite(
          Number(snapshot.readiness?.dependency_generation),
        )
        ? Number(snapshot.readiness?.dependency_generation)
        : null,
    },
  };
}

async function one(
  // deno-lint-ignore no-explicit-any
  query: PromiseLike<{ data: any; error: any }>,
  label: string,
): Promise<LiveRow | null> {
  const { data, error } = await query;
  if (error) {
    throw new SesAssemblerAdapterError(
      "ses_adapter_read_failed",
      `${label} read failed: ${error.message || String(error)}`,
    );
  }
  return data ? record(data) : null;
}

async function many(
  // deno-lint-ignore no-explicit-any
  query: PromiseLike<{ data: any; error: any }>,
  label: string,
): Promise<LiveRow[]> {
  const { data, error } = await query;
  if (error) {
    throw new SesAssemblerAdapterError(
      "ses_adapter_read_failed",
      `${label} read failed: ${error.message || String(error)}`,
    );
  }
  return array(data).map(record);
}

export async function loadSesAssemblerLiveSnapshot(
  // deno-lint-ignore no-explicit-any
  client: any,
  selection: Selection,
): Promise<SesAssemblerLiveSnapshot> {
  let jobQuery = client.from("jobs").select("*");
  jobQuery = selection.mode === "job_id"
    ? jobQuery.eq("id", selection.job_id)
    : jobQuery.eq("job_number", selection.job_number);
  const job = await one(jobQuery.maybeSingle(), "jobs");
  const metadata = record(job?.metadata);
  const isRestoration = job?.type === "insurance" &&
    canonicalSesFamilyFromCard({
        makesafe_job_family: metadata.makesafe_job_family,
        insurance_job_type: metadata.insurance_job_type,
      }) === "restoration";
  if (!job || (job.type !== "makesafe" && !isRestoration)) {
    throw new SesAssemblerAdapterError(
      "ses_card_not_found",
      "No SES reporting card matched the requested selection.",
      404,
    );
  }
  const jobId = text(job.id);
  const [
    detail,
    identityRevision,
    casesByJob,
    casesByTarget,
    cycles,
    reports,
    assignments,
    media,
    documents,
    roofDraft,
    readiness,
    portalCaptures,
    packs,
    events,
    outboundBindings,
    inboundBindings,
    docketRevisions,
  ] = await Promise.all([
    one(
      client
        .from("makesafe_job_details")
        .select("*, makesafe_companies:requesting_company_id(*)")
        .eq("job_id", jobId)
        .maybeSingle(),
      "makesafe_job_details",
    ),
    one(
      client.from("makesafe_state_identity_current_v2").select("*")
        .eq("job_id", jobId).maybeSingle(),
      "makesafe_state_identity_current_v2",
    ),
    many(
      client.from("makesafe_intake_cases").select("*").eq("job_id", jobId),
      "makesafe_intake_cases.job_id",
    ),
    many(
      client
        .from("makesafe_intake_cases")
        .select("*")
        .eq("target_job_id", jobId),
      "makesafe_intake_cases.target_job_id",
    ),
    many(
      client
        .from("makesafe_attendance_cycles")
        .select("*")
        .eq("job_id", jobId)
        .order("cycle_number", { ascending: true }),
      "makesafe_attendance_cycles",
    ),
    many(
      client
        .from("job_service_reports")
        .select("*")
        .eq("job_id", jobId)
        .order("submitted_at", { ascending: false }),
      "job_service_reports",
    ),
    many(
      client
        .from("job_assignments")
        // `users:user_id(name)` mirrors the board's own join (index.ts makesafeCrew), so U4 can
        // see the crew the board already displays. Name only: no phone, no email.
        .select("*, users:user_id(name)")
        .eq("job_id", jobId)
        .neq("status", "cancelled"),
      "job_assignments",
    ),
    many(
      client
        .from("job_media")
        .select("*")
        .eq("job_id", jobId)
        .order("created_at", { ascending: true }),
      "job_media",
    ),
    many(
      client
        .from("job_documents")
        .select("*")
        .eq("job_id", jobId)
        .order("created_at", { ascending: true }),
      "job_documents",
    ),
    one(
      client
        .from("makesafe_roof_report_drafts")
        .select("*")
        .eq("job_id", jobId)
        .eq("pack_kind", "roof")
        .maybeSingle(),
      "makesafe_roof_report_drafts",
    ),
    one(
      client
        .from("makesafe_readiness_current")
        .select("*")
        .eq("job_id", jobId)
        .maybeSingle(),
      "makesafe_readiness_current",
    ),
    many(
      client
        .from("makesafe_portal_capture_revisions")
        .select("*")
        .eq("job_id", jobId)
        .order("makesafe_fact_version", { ascending: false }),
      "makesafe_portal_capture_revisions",
    ),
    many(
      client.from("makesafe_report_packs").select("*").eq("job_id", jobId),
      "makesafe_report_packs",
    ),
    many(
      client
        .from("job_events")
        .select("id,job_id,event_type,detail_json,created_at")
        .eq("job_id", jobId)
        .eq("event_type", "note")
        .order("created_at", { ascending: false }),
      "job_events.bundle_candidate",
    ),
    many(
      client
        .from("makesafe_sibling_bundle_binding_revisions")
        .select(
          "id,bundle_id,org_id,job_id,sibling_job_id,state,recorded_by,recorded_via,provenance,recorded_at",
        )
        .eq("job_id", jobId),
      "makesafe_sibling_bundle_binding_revisions.job_id",
    ),
    many(
      client
        .from("makesafe_sibling_bundle_binding_revisions")
        .select(
          "id,bundle_id,org_id,job_id,sibling_job_id,state,recorded_by,recorded_via,provenance,recorded_at",
        )
        .eq("sibling_job_id", jobId),
      "makesafe_sibling_bundle_binding_revisions.sibling_job_id",
    ),
    many(
      client
        .from("makesafe_docket_revisions")
        .select(
          "id,job_id,current_attendance_cycle_id,output_content_hash,committed_at",
        )
        .eq("job_id", jobId)
        .order("committed_at", { ascending: false }),
      "makesafe_docket_revisions.report_sources",
    ),
  ]);
  const docketRevisionIds = docketRevisions.map((row) => text(row.id)).filter(
    Boolean,
  );
  const docketArtifacts = docketRevisionIds.length
    ? await many(
      client
        .from("makesafe_docket_artifacts")
        .select(
          "id,revision_id,role,object_key,media_type,content_hash,size_bytes,metadata,created_at",
        )
        .in("revision_id", docketRevisionIds)
        .eq("role", "supporting_report_pdf"),
      "makesafe_docket_artifacts.report_sources",
    )
    : [];
  const caseMap = new Map<string, LiveRow>();
  for (const item of [...casesByJob, ...casesByTarget]) {
    if (text(item.id)) caseMap.set(text(item.id), item);
  }
  const bindingMap = new Map<string, LiveRow>();
  for (const row of [...outboundBindings, ...inboundBindings]) {
    if (text(row.id)) bindingMap.set(text(row.id), row);
  }
  const bundleBindings = [...bindingMap.values()];
  const siblingJobIds = [
    ...new Set(
      bundleBindings.flatMap((row) => [
        text(row.job_id),
        text(row.sibling_job_id),
      ]).filter((id) => id && id !== jobId),
    ),
  ];
  const outboundRevisionIds = bundleBindings
    .filter((row) => text(row.job_id) === jobId)
    .map((row) => text(row.id))
    .filter(Boolean);
  const [
    bundleJobs,
    bundleDetails,
    bundleReports,
    bundleAssignments,
    bundleClaims,
  ] = await Promise.all([
    siblingJobIds.length
      ? many(
        client.from("jobs").select("id,job_number,client_name").in(
          "id",
          siblingJobIds,
        ),
        "jobs.bundle_siblings",
      )
      : Promise.resolve([]),
    siblingJobIds.length
      ? many(
        client.from("makesafe_job_details")
          .select("job_id,attendance_cycle_id,cycle_number,reattend_count")
          .in("job_id", siblingJobIds),
        "makesafe_job_details.bundle_siblings",
      )
      : Promise.resolve([]),
    siblingJobIds.length
      ? many(
        client.from("job_service_reports")
          .select(
            "id,job_id,status,submitted_at,attendance_cycle_id,cycle_attribution,cycle_number,checklist_json,notes",
          )
          .in("job_id", siblingJobIds)
          .order("submitted_at", { ascending: false }),
        "job_service_reports.bundle_siblings",
      )
      : Promise.resolve([]),
    siblingJobIds.length
      ? many(
        client.from("job_assignments")
          .select(
            "id,job_id,status,attendance_cycle_id,cycle_attribution,cycle_number,crew_name,scheduled_date,arrived_at,updated_at,created_at,users:user_id(name)",
          )
          .in("job_id", siblingJobIds)
          .neq("status", "cancelled"),
        "job_assignments.bundle_siblings",
      )
      : Promise.resolve([]),
    outboundRevisionIds.length
      ? many(
        client
          .from("makesafe_sibling_evidence_claims")
          .select("*")
          .in("binding_revision_id", outboundRevisionIds),
        "makesafe_sibling_evidence_claims",
      )
      : Promise.resolve([]),
  ]);
  const invoiceIds = [
    ...new Set(bundleClaims.map((row) => text(row.invoice_id)).filter(Boolean)),
  ];
  const documentIds = [
    ...new Set(
      bundleClaims.flatMap((row) => [
        text(row.report_document_id),
        text(row.swms_document_id),
      ]).filter(Boolean),
    ),
  ];
  const emailIds = [
    ...new Set(
      bundleClaims.map((row) => text(row.delivery_email_post_id)).filter(
        Boolean,
      ),
    ),
  ];
  const mediaIds = [
    ...new Set(
      bundleClaims.map((row) => text(row.photo_media_id)).filter(Boolean),
    ),
  ];
  const [bundleInvoices, bundleDocuments, bundleEmails, bundleMedia] =
    await Promise.all([
      invoiceIds.length
        ? many(
          client
            .from("xero_invoices")
            .select("id,job_id,invoice_number,status,line_items")
            .in("id", invoiceIds),
          "xero_invoices.bundle_evidence",
        )
        : Promise.resolve([]),
      documentIds.length
        ? many(
          client
            .from("job_documents")
            .select("id,job_id,type,file_name,pdf_url,storage_url")
            .in("id", documentIds),
          "job_documents.bundle_evidence",
        )
        : Promise.resolve([]),
      emailIds.length
        ? many(
          client
            .from("emails")
            .select(
              "post_id,subject,body_preview,has_attachments,content_sha256",
            )
            .in("post_id", emailIds),
          "emails.bundle_evidence",
        )
        : Promise.resolve([]),
      mediaIds.length
        ? many(
          client
            .from("job_media")
            .select(
              "id,job_id,type,storage_url,label,notes,makesafe_content_hash",
            )
            .in("id", mediaIds),
          "job_media.bundle_evidence",
        )
        : Promise.resolve([]),
    ]);
  return {
    job,
    detail,
    identity_revision: identityRevision,
    cases: [...caseMap.values()],
    cycles,
    reports,
    assignments,
    media,
    documents,
    roof_draft: roofDraft,
    readiness,
    portal_captures: portalCaptures,
    legacy_packs: packs,
    docket_revisions: docketRevisions,
    docket_artifacts: docketArtifacts,
    events,
    bundle_bindings: bundleBindings,
    bundle_claims: bundleClaims,
    bundle_jobs: bundleJobs,
    bundle_details: bundleDetails,
    bundle_reports: bundleReports,
    bundle_assignments: bundleAssignments,
    bundle_invoices: bundleInvoices,
    bundle_documents: bundleDocuments,
    bundle_emails: bundleEmails,
    bundle_media: bundleMedia,
  };
}

function fileName(row: LiveRow, fallback: string): string {
  const raw = firstText(row.file_name, row.filename, fallback)
    .replaceAll("\\", "/")
    .split("/")
    .pop() || fallback;
  return raw.replaceAll("..", "").replace(/[^A-Za-z0-9._ -]+/g, "-");
}

function artifactUrl(row: LiveRow): string {
  return firstText(
    row.pdf_url,
    row.file_url,
    row.public_url,
    row.storage_url,
    row.url,
    row.thumbnail_url,
  );
}

function durableCuratedDocumentForCycle(
  snapshot: SesAssemblerLiveSnapshot,
  currentCycleId: string,
): LiveRow | null {
  return snapshot.documents
    .filter((row) => text(row.type).toLowerCase() === "makesafe_report")
    .filter((row) => row.visible_to_trades === true)
    .filter((row) => {
      const provenance = record(row.data_snapshot_json);
      if (
        text(provenance.report_contract_version) !==
          MAKESAFE_REPORT_CONTRACT_VERSION ||
        !isCurrentCuratedRendererVersion(
          text(provenance.report_renderer_version),
        ) ||
        !/^[0-9a-f]{64}$/.test(text(provenance.report_render_hash)) ||
        text(provenance.evidence_source) !==
          "current_cycle_curated_makesafe_report" ||
        text(provenance.curated_source_kind) !==
          "durable_curated_revision" ||
        !text(provenance.curated_source_identity) ||
        text(provenance.curated_source_identity) === text(row.id) ||
        !text(provenance.curated_source_revision_id) ||
        !text(provenance.curated_source_artifact_id) ||
        !isSesSha256(text(provenance.curated_source_artifact_content_hash)) ||
        !isSesSha256(text(provenance.curated_source_expected_raw_sha256)) ||
        text(provenance.report_renderer_source_revision) !==
          MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION ||
        text(provenance.report_renderer_script_sha256) !==
          MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256 ||
        !/^sha256:[0-9a-f]{64}$/.test(
          text(provenance.report_input_hash),
        )
      ) {
        return false;
      }
      if (currentCycleId) {
        return text(row.attendance_cycle_id) === currentCycleId &&
          text(row.cycle_attribution).toLowerCase() === "bound";
      }
      return isEvidenceBoundToCurrentCycle(
        row,
        snapshot.detail || {},
        currentCycleId || null,
      );
    })
    .slice()
    .sort((left, right) =>
      Number(right.version || 0) - Number(left.version || 0) ||
      text(right.created_at).localeCompare(text(left.created_at)) ||
      text(right.id).localeCompare(text(left.id))
    )[0] || null;
}

interface PhysicalReportSource {
  proof: SesPhysicalReportProof;
  document: LiveRow;
  artifact?: LiveRow;
}

function rawReportHash(value: unknown): SesSha256 | null {
  const hash = text(value).toLowerCase().replace(/^sha256:/, "");
  return /^[0-9a-f]{64}$/.test(hash) ? `sha256:${hash}` : null;
}

function physicalReportSourceForCycle(
  snapshot: SesAssemblerLiveSnapshot,
  currentCycleId: string,
  reportDocumentId?: string,
): PhysicalReportSource | null {
  const revisions = new Map(
    (snapshot.docket_revisions || []).map((row) => [text(row.id), row]),
  );
  const documents = new Map(
    snapshot.documents.map((row) => [text(row.id), row]),
  );
  const candidates: Array<PhysicalReportSource & { committed_at: string }> = [];
  for (const document of snapshot.documents) {
    const durable = durableCuratedDocumentForCycle(
      { ...snapshot, documents: [document] },
      currentCycleId,
    );
    if (
      !durable || (reportDocumentId && text(durable.id) !== reportDocumentId)
    ) {
      continue;
    }
    const provenance = record(durable.data_snapshot_json);
    const sourceRevisionId = text(provenance.curated_source_revision_id);
    const sourceArtifactId = text(provenance.curated_source_artifact_id);
    const sourceIdentity = text(provenance.curated_source_identity);
    const sourceArtifactContentHash = text(
      provenance.curated_source_artifact_content_hash,
    );
    const expectedRawSha256 = rawReportHash(
      provenance.curated_source_expected_raw_sha256 ||
        provenance.report_render_hash,
    );
    if (
      sourceIdentity !==
        `curation-revision:${sourceRevisionId}/artifact:${sourceArtifactId}` ||
      !isSesSha256(sourceArtifactContentHash) || !expectedRawSha256
    ) continue;
    candidates.push({
      document: durable,
      committed_at: text(durable.created_at),
      proof: {
        source_kind: "durable_curated_revision",
        source_identity: sourceIdentity,
        source_document_id: text(durable.id),
        source_revision_id: sourceRevisionId,
        source_artifact_id: sourceArtifactId,
        source_artifact_content_hash: sourceArtifactContentHash as SesSha256,
        expected_raw_sha256: expectedRawSha256,
        report_input_hash: text(provenance.report_input_hash) as SesSha256,
      },
    });
  }
  for (const artifact of snapshot.docket_artifacts || []) {
    if (
      text(artifact.role) !== "supporting_report_pdf" ||
      text(artifact.media_type) !== "application/pdf"
    ) continue;
    const revision = revisions.get(text(artifact.revision_id));
    if (
      !revision || text(revision.current_attendance_cycle_id) !==
        currentCycleId ||
      !text(revision.committed_at)
    ) continue;
    const metadata = record(artifact.metadata);
    const document = documents.get(text(metadata.report_document_id));
    if (reportDocumentId && text(document?.id) !== reportDocumentId) continue;
    const provenance = record(document?.data_snapshot_json);
    const expectedRawSha256 = rawReportHash(
      metadata.output_sha256 || metadata.render_hash,
    );
    const artifactContentHash = text(artifact.content_hash);
    const artifactInputHash = text(metadata.report_input_hash);
    const documentBinding = sesSupportingReportDocumentBinding(
      expectedRawSha256,
      provenance,
    );
    const inputHash = isSesSha256(artifactInputHash)
      ? artifactInputHash
      : (documentBinding === "matched"
        ? text(provenance.report_input_hash)
        : "");
    const trust = inspectSesSupportingReportProof(artifact);
    // Restorable docket lineage without an independent completeness coordinate
    // (report_input_hash from curated bind accounting) is not a source. Allow
    // selection only when the document still carries a hash bound to these
    // bytes so prepare can re-stamp the artifact; pure self-vouching metadata
    // remains refused. The refusal reason is raised before the size budget, so
    // bound the size here too rather than inherit an unchecked artifact.
    const completenessRecoverable = !trust.trusted &&
      trust.reason === "independent_completeness_proof_missing" &&
      isSesSha256(inputHash);
    if (
      (!trust.trusted && !completenessRecoverable) ||
      !document || document.visible_to_trades !== true ||
      text(document.type).toLowerCase() !== "makesafe_report" ||
      text(document.attendance_cycle_id) !== currentCycleId ||
      text(document.cycle_attribution).toLowerCase() !== "bound" ||
      !expectedRawSha256 || !text(artifact.id) ||
      !text(artifact.object_key) || !isSesSha256(artifactContentHash) ||
      !Number.isSafeInteger(Number(artifact.size_bytes)) ||
      Number(artifact.size_bytes) <= 0 ||
      Number(artifact.size_bytes) > SES_SUPPORTING_REPORT_MAX_BYTES ||
      text(document.uploaded_by) === "guarded-current-wiki-rerender-sweep" ||
      documentBinding === "diverged" || !isSesSha256(inputHash)
    ) continue;
    candidates.push({
      document,
      artifact,
      committed_at: text(revision.committed_at),
      proof: {
        source_kind: "previously_committed_pdf",
        source_identity: `docket-revision:${text(revision.id)}/artifact:${
          text(artifact.id)
        }`,
        source_document_id: text(document.id),
        source_revision_id: text(revision.id),
        source_artifact_id: text(artifact.id),
        source_artifact_content_hash: artifactContentHash as SesSha256,
        expected_raw_sha256: expectedRawSha256,
        report_input_hash: inputHash as SesSha256,
      },
    });
  }
  return candidates.sort((left, right) =>
    Number(right.proof.source_kind === "durable_curated_revision") -
      Number(left.proof.source_kind === "durable_curated_revision") ||
    right.committed_at.localeCompare(left.committed_at) ||
    right.proof.source_revision_id!.localeCompare(
      left.proof.source_revision_id!,
    )
  )[0] || null;
}

export function selectPhysicalReportProofForCycle(
  snapshot: SesAssemblerLiveSnapshot,
  currentCycleId: string,
  reportDocumentId?: string,
): SesPhysicalReportProof | null {
  return physicalReportSourceForCycle(
    snapshot,
    currentCycleId,
    reportDocumentId,
  )
    ?.proof || null;
}

/**
 * A document becomes builder-serving authority only through a committed,
 * immutable same-cycle docket artifact whose exact artifact and raw PDF hashes
 * are retained. Document provenance alone, including the retired sweep's
 * self-authored stamp, is never sufficient.
 */
function currentCuratedReportDocumentForCycle(
  snapshot: SesAssemblerLiveSnapshot,
  currentCycleId: string,
): LiveRow | null {
  return physicalReportSourceForCycle(snapshot, currentCycleId)?.document ||
    null;
}

function currentCuratedReportScopeNarratives(
  snapshot: SesAssemblerLiveSnapshot,
  currentCycleId: string,
): string[] {
  const row = currentCuratedReportDocumentForCycle(snapshot, currentCycleId);
  return array(
    record(row?.data_snapshot_json).report_scope_narratives,
  ).map(text).filter(Boolean);
}

export function currentCuratedReportDocument(
  snapshot: SesAssemblerLiveSnapshot,
  input: SesAssemblerInputV1,
): LiveRow | null {
  return currentCuratedReportDocumentForCycle(
    snapshot,
    text(input.attendance.current_attendance_cycle_id),
  );
}

async function fetchBytes(
  url: string,
  label: string,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!/^https:\/\//i.test(url)) {
    throw new SesAssemblerAdapterError(
      "ses_artifact_unrecoverable",
      `${label} has no HTTPS recovery URL.`,
    );
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new SesAssemblerAdapterError(
      "ses_artifact_unrecoverable",
      `${label} recovery returned HTTP ${response.status}.`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function rawPhotoSha256(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<SesSha256> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes),
  );
  const hex = Array.from(digest)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

function persistedCaptureContent(
  row: SesPersistedPortalCaptureRow,
): SesPortalCaptureRevisionContent {
  return {
    job_id: row.job_id,
    attendance_cycle_id: row.attendance_cycle_id,
    role: row.role,
    capture_result: row.capture_result,
    source_url: row.source_url,
    source_content_hash: row.source_content_hash,
    builder_reference: row.builder_reference,
    captured_at: row.captured_at,
    captured_by: row.captured_by,
    capture_producer: row.capture_producer,
    capture_idempotency_key: row.capture_idempotency_key,
    signal: row.signal,
    screenshot_object_key: row.screenshot_object_key,
    screenshot_media_type: row.screenshot_media_type,
    screenshot_content_hash: row.screenshot_content_hash,
    screenshot_size_bytes: row.screenshot_size_bytes,
  };
}

async function missingPersistedPortalCapture(
  request: SesPortalCaptureRequest,
  cycleId: string,
): Promise<SesPortalCapture> {
  return {
    status: "missing",
    role: request.role,
    url: request.url,
    docket_id: request.docket_id,
    job_id: request.job_id,
    builder_reference: request.builder_reference,
    captured_at: new Date(0).toISOString(),
    captured_by: "",
    capture_producer: "",
    evidence_revision_id: "",
    content_fingerprint: await rawPhotoSha256(
      new TextEncoder().encode(
        `${request.job_id}:${cycleId}:${request.role}:${request.url}`,
      ),
    ),
    idempotency_key: request.idempotency_key,
    signal:
      `No persisted portal capture matches job_id=${request.job_id}, attendance_cycle_id=${
        cycleId || "(missing)"
      }, role=${request.role}, source_url=${request.url}.`,
  };
}

function invalidPersistedPortalCapture(
  request: SesPortalCaptureRequest,
  row: SesPersistedPortalCaptureRow,
  signal: string,
): SesPortalCapture {
  return {
    status: "invalid",
    role: request.role,
    url: request.url,
    docket_id: request.docket_id,
    job_id: request.job_id,
    builder_reference: request.builder_reference,
    captured_at: row.captured_at,
    captured_by: row.captured_by,
    capture_producer: row.capture_producer,
    evidence_revision_id: row.id,
    content_fingerprint: row.source_content_hash,
    idempotency_key: row.capture_idempotency_key,
    signal,
  };
}

async function resolvePersistedPortalCapture(
  // deno-lint-ignore no-explicit-any
  client: any,
  snapshot: SesAssemblerLiveSnapshot,
  request: SesPortalCaptureRequest,
): Promise<SesPortalCapture> {
  const cycleId = text(snapshot.detail?.attendance_cycle_id);
  const sourceUrl = canonicalSesPortalSourceUrl(request.url);
  const matches = snapshot.portal_captures
    .map((row) => row as SesPersistedPortalCaptureRow)
    .filter((row) =>
      // The docket needs the SCREENSHOT the capture produced, so U4 selects
      // only the screenshot-bearing reader. The trade attestation producer
      // (captain, 2026-08-02) is deliberately excluded here, and excluded at
      // the CANDIDATE step rather than the validation step: a newer attestation
      // must not shadow a valid reader capture and turn a good docket invalid.
      // Whether an attestation can stand in for the docket screenshot is its
      // own release, not a side effect of this one.
      sesPortalCaptureProducerHasScreenshot(row.capture_producer) &&
      row.job_id === request.job_id &&
      row.attendance_cycle_id === cycleId &&
      canonicalSesPortalCaptureRole(row.role) === request.role &&
      sourceUrl !== null &&
      canonicalSesPortalSourceUrl(row.source_url) === sourceUrl &&
      row.builder_reference === request.builder_reference
    )
    .sort((left, right) =>
      Number(right.makesafe_fact_version) -
        Number(left.makesafe_fact_version) ||
      String(right.created_at).localeCompare(String(left.created_at))
    );
  const row = matches[0];
  if (!row) return await missingPersistedPortalCapture(request, cycleId);

  const result = canonicalSesPortalCaptureResult(row.capture_result);
  const role = canonicalSesPortalCaptureRole(row.role);
  if (
    !result || role !== request.role ||
    !isSesSha256(row.source_content_hash) ||
    !isSesSha256(row.makesafe_content_hash) ||
    !row.captured_by?.trim() ||
    !isTrustedSesPortalCaptureProducer(row.capture_producer) ||
    !row.id?.trim()
  ) {
    return invalidPersistedPortalCapture(
      request,
      row,
      `Persisted portal capture ${
        row.id || "(missing id)"
      } has invalid provenance.`,
    );
  }
  if (
    await sesPortalCaptureRevisionHash(persistedCaptureContent(row)) !==
      row.makesafe_content_hash
  ) {
    return invalidPersistedPortalCapture(
      request,
      row,
      `Persisted portal capture ${row.id} failed its aggregate content-hash check.`,
    );
  }

  let screenshotBytes: Uint8Array | undefined;
  if (result !== "unreachable") {
    const prefix = `${SES_PORTAL_CAPTURE_BUCKET}/`;
    if (
      !row.screenshot_object_key?.startsWith(prefix) ||
      row.screenshot_media_type !== "image/png" ||
      !isSesSha256(row.screenshot_content_hash) ||
      !Number.isSafeInteger(Number(row.screenshot_size_bytes)) ||
      Number(row.screenshot_size_bytes) <= 0
    ) {
      return invalidPersistedPortalCapture(
        request,
        row,
        `Persisted portal capture ${row.id} has no valid tied screenshot reference.`,
      );
    }
    const storagePath = row.screenshot_object_key.slice(prefix.length);
    const downloaded = await client.storage.from(SES_PORTAL_CAPTURE_BUCKET)
      .download(storagePath);
    if (downloaded.error || !downloaded.data) {
      return invalidPersistedPortalCapture(
        request,
        row,
        `Persisted portal capture ${row.id} screenshot could not be downloaded.`,
      );
    }
    screenshotBytes = new Uint8Array(await downloaded.data.arrayBuffer());
    if (
      !isSesPortalCapturePng(screenshotBytes) ||
      screenshotBytes.byteLength !== Number(row.screenshot_size_bytes) ||
      await rawSesPortalCaptureSha256(screenshotBytes) !==
        row.screenshot_content_hash
    ) {
      return invalidPersistedPortalCapture(
        request,
        row,
        `Persisted portal capture ${row.id} screenshot failed its byte-hash check.`,
      );
    }
  }

  return {
    status: result,
    role: request.role,
    url: request.url,
    docket_id: request.docket_id,
    job_id: request.job_id,
    builder_reference: request.builder_reference,
    captured_at: row.captured_at,
    captured_by: row.captured_by,
    capture_producer: row.capture_producer,
    evidence_revision_id: row.id,
    content_fingerprint: row.source_content_hash,
    idempotency_key: row.capture_idempotency_key,
    signal: row.signal,
    ...(screenshotBytes ? { screenshot_bytes: screenshotBytes } : {}),
  };
}

function mediaType(row: LiveRow, fallback: string): string {
  return firstText(row.content_type, row.media_type, row.mime_type, fallback);
}

export function createSesAssemblerRuntimeDependencies(
  // deno-lint-ignore no-explicit-any
  client: any,
  options: { org_id: string; created_by: string },
): SesPrepareDependencies {
  const snapshots = new Map<string, SesAssemblerLiveSnapshot>();
  const load = async (selection: Selection) => {
    const snapshot = await loadSesAssemblerLiveSnapshot(client, selection);
    const input = buildSesAssemblerInput(snapshot);
    snapshots.set(input.identity.job_id, snapshot);
    return input;
  };
  const snapshotFor = (input: SesAssemblerInputV1) => {
    const snapshot = snapshots.get(input.identity.job_id);
    if (!snapshot) {
      throw new SesAssemblerAdapterError(
        "ses_adapter_snapshot_missing",
        "Assembler artifact recovery ran before the canonical card snapshot.",
      );
    }
    return snapshot;
  };
  const snapshotForJobId = (jobId: string) => {
    const snapshot = snapshots.get(jobId);
    if (!snapshot) {
      throw new SesAssemblerAdapterError(
        "ses_adapter_snapshot_missing",
        "Portal capture resolution ran before the canonical card snapshot.",
      );
    }
    return snapshot;
  };
  return {
    resolveInput: load,
    listBoardJobs: async (limit) => {
      const rows = await many(
        client
          .from("makesafe_job_details")
          .select("job_id")
          .eq("substatus", "admin_to_send_report")
          .order("updated_at", { ascending: true })
          .limit(limit),
        "makesafe_job_details.board_batch",
      );
      return rows
        .map((item) => ({
          mode: "job_id" as const,
          job_id: text(item.job_id),
        }))
        .filter((item) => item.job_id);
    },
    resolveSourceArtifacts: async (input) => {
      const snapshot = snapshotFor(input);
      const byPointer = new Map(
        snapshot.documents.map((item) => [
          `job_document:${text(item.id)}`,
          item,
        ]),
      );
      const out = [];
      for (const pointer of input.source.attachment_pointers) {
        const row = byPointer.get(pointer);
        if (!row) continue;
        const url = artifactUrl(row);
        if (!url) continue;
        try {
          out.push({
            source_pointer: pointer,
            file_name: fileName(row, "work-order.pdf"),
            media_type: mediaType(row, "application/pdf"),
            bytes: await fetchBytes(url, pointer),
          });
        } catch {
          // The assembler compares expected pointers with recovered artifacts and
          // emits the named spine_missing_source blocker. Do not replace that
          // evidence contract with a generic network exception.
        }
      }
      return out;
    },
    resolvePhotoArtifacts: async (input) => {
      const snapshot = snapshotFor(input);
      const byPointer = new Map(
        snapshot.media.map((item) => [`job_media:${text(item.id)}`, item]),
      );
      const out = [];
      for (const photo of input.cycle_facts.photos) {
        const row = byPointer.get(photo.path_or_key);
        if (!row) continue;
        const rawType = mediaType(row, "image/jpeg");
        if (rawType !== "image/jpeg" && rawType !== "image/png") continue;
        const type: "image/jpeg" | "image/png" = rawType;
        const url = artifactUrl(row);
        if (!url) continue;
        try {
          out.push({
            photo_id: photo.id,
            source_pointer: photo.path_or_key,
            file_name: fileName(
              row,
              `${photo.id}.${type === "image/png" ? "png" : "jpg"}`,
            ),
            media_type: type,
            bytes: await fetchBytes(url, photo.path_or_key),
          });
        } catch {
          // Missing bytes stay a typed trade_evidence_missing blocker in U4.
        }
      }
      return out;
    },
    resolvePhotoProofs: async (input): Promise<SesPhotoProof[]> => {
      const snapshot = snapshotFor(input);
      const byPointer = new Map(
        snapshot.media.map((item) => [`job_media:${text(item.id)}`, item]),
      );
      const out: SesPhotoProof[] = [];
      for (const photo of input.cycle_facts.photos) {
        const row = byPointer.get(photo.path_or_key);
        if (!row) continue;
        const rawType = mediaType(row, "image/jpeg");
        if (rawType !== "image/jpeg" && rawType !== "image/png") continue;
        const media_type: "image/jpeg" | "image/png" = rawType;
        const url = artifactUrl(row);
        if (!url) continue;
        try {
          // A dry-run keeps only this bounded proof. It never retains the
          // photo bytes across iterations and never base64-encodes or renders
          // them into a PDF inside the synchronous request.
          const bytes = await fetchBytes(url, photo.path_or_key);
          out.push({
            photo_id: photo.id,
            source_pointer: photo.path_or_key,
            file_name: fileName(
              row,
              `${photo.id}.${media_type === "image/png" ? "png" : "jpg"}`,
            ),
            media_type,
            content_hash: await rawPhotoSha256(bytes),
            size_bytes: bytes.byteLength,
          });
        } catch {
          // Missing proofs remain a typed trade_evidence_missing blocker.
        }
      }
      return out;
    },
    capturePortal: async (request) =>
      await resolvePersistedPortalCapture(
        client,
        snapshotForJobId(request.job_id),
        request,
      ),
    resolvePhysicalReportProof: (input) => {
      const snapshot = snapshotFor(input);
      return Promise.resolve(
        selectPhysicalReportProofForCycle(
          snapshot,
          text(input.attendance.current_attendance_cycle_id),
        ),
      );
    },
    resolveBundledPhysicalReportProof: async (input) => {
      const bundle = input.sibling_bundle_evidence;
      if (!bundle || bundle.status !== "accepted") return null;
      const siblingSnapshot = await loadSesAssemblerLiveSnapshot(client, {
        mode: "job_id",
        job_id: bundle.sibling.job_id,
      });
      const siblingCycleId = text(siblingSnapshot.detail?.attendance_cycle_id);
      return selectPhysicalReportProofForCycle(
        siblingSnapshot,
        siblingCycleId,
        bundle.coverage.report_document_id,
      );
    },
    renderBundledPhysicalReport: async (input, proof) => {
      const bundle = input.sibling_bundle_evidence;
      if (!bundle || bundle.status !== "accepted") return null;
      const siblingSnapshot = await loadSesAssemblerLiveSnapshot(client, {
        mode: "job_id",
        job_id: bundle.sibling.job_id,
      });
      const source = physicalReportSourceForCycle(
        siblingSnapshot,
        text(siblingSnapshot.detail?.attendance_cycle_id),
        bundle.coverage.report_document_id,
      );
      if (
        !source || source.proof.source_kind !== proof.source_kind ||
        source.proof.source_identity !== proof.source_identity ||
        source.proof.source_document_id !== proof.source_document_id ||
        source.proof.source_revision_id !== proof.source_revision_id ||
        source.proof.source_artifact_id !== proof.source_artifact_id ||
        source.proof.source_artifact_content_hash !==
          proof.source_artifact_content_hash ||
        source.proof.expected_raw_sha256 !== proof.expected_raw_sha256 ||
        source.proof.report_input_hash !== proof.report_input_hash
      ) {
        return null;
      }
      let bytes: Uint8Array;
      if (source.artifact) {
        const objectKey = text(source.artifact.object_key);
        const prefix = `${SES_DOCKET_BUCKET}/`;
        const storagePath = objectKey.startsWith(prefix)
          ? objectKey.slice(prefix.length)
          : objectKey;
        const recovered = await client.storage.from(SES_DOCKET_BUCKET)
          .download(storagePath);
        if (recovered.error || !recovered.data) return null;
        bytes = new Uint8Array(await recovered.data.arrayBuffer());
      } else {
        const url = artifactUrl(source.document);
        if (!url.startsWith("https://")) return null;
        const recovered = await fetch(url, {
          signal: AbortSignal.timeout(20_000),
        });
        if (!recovered.ok) return null;
        bytes = new Uint8Array(await recovered.arrayBuffer());
      }
      if (
        bytes.byteLength === 0 ||
        bytes.byteLength > SES_SUPPORTING_REPORT_MAX_BYTES ||
        await sesSha256Bytes(bytes) !== proof.source_artifact_content_hash ||
        await rawReportHash(
            await rawPhotoSha256(bytes as Uint8Array<ArrayBuffer>),
          ) !==
          proof.expected_raw_sha256 ||
        new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-"
      ) return null;
      return {
        file_name: fileName(
          source.document,
          `${bundle.sibling.job_number}-report.pdf`,
        ),
        media_type: "application/pdf",
        bytes,
        render_hash: proof.expected_raw_sha256,
        provenance: {
          evidence_source: "explicit_sibling_bundle",
          report_document_id: proof.source_document_id,
          report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
          report_renderer_version: text(
            record(source.document.data_snapshot_json).report_renderer_version,
          ),
          report_renderer_source_revision: text(
            record(source.document.data_snapshot_json)
              .report_renderer_source_revision,
          ),
          report_renderer_script_sha256: text(
            record(source.document.data_snapshot_json)
              .report_renderer_script_sha256,
          ),
        },
      };
    },
    renderPhysicalReport: async (input, _photos = [], proof) => {
      const snapshot = snapshotFor(input);
      const source = physicalReportSourceForCycle(
        snapshot,
        text(input.attendance.current_attendance_cycle_id),
      );
      if (
        !source || !proof ||
        source.proof.source_kind !== proof.source_kind ||
        source.proof.source_identity !== proof.source_identity ||
        source.proof.source_document_id !== proof.source_document_id ||
        source.proof.source_revision_id !== proof.source_revision_id ||
        source.proof.source_artifact_id !== proof.source_artifact_id ||
        source.proof.source_artifact_content_hash !==
          proof.source_artifact_content_hash ||
        source.proof.expected_raw_sha256 !== proof.expected_raw_sha256 ||
        source.proof.report_input_hash !== proof.report_input_hash
      ) {
        throw new SesAssemblerAdapterError(
          "ses_curated_report_missing",
          "No exact independent curated source matches the dry-run proof; raw trade-report fields and known guarded-rerender outputs will not be substituted.",
          409,
        );
      }
      let bytes: Uint8Array;
      if (source.artifact) {
        const objectKey = text(source.artifact.object_key);
        const prefix = `${SES_DOCKET_BUCKET}/`;
        const storagePath = objectKey.startsWith(prefix)
          ? objectKey.slice(prefix.length)
          : objectKey;
        const recovered = await client.storage.from(SES_DOCKET_BUCKET)
          .download(storagePath);
        if (recovered.error || !recovered.data) {
          throw new SesAssemblerAdapterError(
            "ses_curated_report_unrecoverable",
            `Committed docket artifact ${proof.source_artifact_id} could not be recovered.`,
            409,
          );
        }
        bytes = new Uint8Array(await recovered.data.arrayBuffer());
      } else {
        const url = artifactUrl(source.document);
        if (!url.startsWith("https://")) {
          throw new SesAssemblerAdapterError(
            "ses_curated_report_unrecoverable",
            `Durable curated source ${proof.source_identity} is not recoverable.`,
            409,
          );
        }
        const recovered = await fetch(url, {
          signal: AbortSignal.timeout(20_000),
        });
        if (!recovered.ok) {
          throw new SesAssemblerAdapterError(
            "ses_curated_report_unrecoverable",
            `Durable curated source ${proof.source_identity} returned HTTP ${recovered.status}.`,
            409,
          );
        }
        bytes = new Uint8Array(await recovered.arrayBuffer());
      }
      if (
        bytes.byteLength === 0 ||
        bytes.byteLength > SES_SUPPORTING_REPORT_MAX_BYTES ||
        await sesSha256Bytes(bytes) !== proof.source_artifact_content_hash ||
        await rawPhotoSha256(bytes as Uint8Array<ArrayBuffer>) !==
          proof.expected_raw_sha256
      ) {
        throw new SesAssemblerAdapterError(
          "ses_curated_report_unrecoverable",
          `Curated report source ${proof.source_identity} does not match its committed artifact content hash.`,
          409,
        );
      }
      if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") {
        throw new SesAssemblerAdapterError(
          "ses_curated_report_unrecoverable",
          `Curated report source ${proof.source_identity} is not a PDF artifact.`,
          409,
        );
      }
      const provenance = record(source.document.data_snapshot_json);
      return {
        file_name: fileName(
          source.document,
          `Make Safe Report - ${input.source.builder_reference}.pdf`,
        ),
        media_type: "application/pdf",
        bytes,
        render_hash: proof.expected_raw_sha256,
        provenance: {
          evidence_source: "current_cycle_curated_makesafe_report",
          report_document_id: proof.source_document_id,
          report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
          report_renderer_version: text(provenance.report_renderer_version),
          report_renderer_source_revision: text(
            provenance.report_renderer_source_revision,
          ),
          report_renderer_script_sha256: text(
            provenance.report_renderer_script_sha256,
          ),
        },
      };
    },
    renderOwnRoofReport: async (input) => {
      const snapshot = snapshotFor(input);
      const fields = record(input.cycle_facts.roof_report_fields);
      const job = buildRoofReportJob(fields, {
        ref: input.source.builder_reference,
        address: input.source.site_address || "Address not recorded",
        contact: firstText(snapshot.job.client_name),
        client: firstText(snapshot.job.client_name),
        job_number: input.identity.job_number || undefined,
      });
      const rendered = await renderRoofReportPdf(
        job as unknown as RoofReportJob,
      );
      return {
        file_name: rendered.fileName,
        media_type: "application/pdf",
        bytes: rendered.bytes,
        render_hash: rendered.renderHash,
      };
    },
    resolveBundledReportArtifact: async (input) => {
      const bundle = input.sibling_bundle_evidence;
      if (!bundle || bundle.status !== "accepted") return null;
      const snapshot = snapshotFor(input);
      const row = (snapshot.bundle_documents || []).find((item) =>
        text(item.id) === bundle.coverage.report_document_id &&
        text(item.job_id) === bundle.sibling.job_id &&
        ["report", "makesafe_report"].includes(text(item.type).toLowerCase())
      );
      if (!row) return null;
      const url = artifactUrl(row);
      if (!url) return null;
      try {
        return {
          file_name: fileName(row, `${bundle.sibling.job_number}-report.pdf`),
          media_type: "application/pdf",
          bytes: await fetchBytes(url, "bundled sibling report"),
        };
      } catch {
        return null;
      }
    },
    resolveBundledPhotoArtifacts: async (input) => {
      const bundle = input.sibling_bundle_evidence;
      if (!bundle || bundle.status !== "accepted") return [];
      const snapshot = snapshotFor(input);
      const row = (snapshot.bundle_media || []).find((item) =>
        text(item.id) === bundle.coverage.photo.media_id &&
        text(item.job_id) === bundle.sibling.job_id &&
        text(item.type).toLowerCase() === "photo" &&
        text(item.makesafe_content_hash) ===
          bundle.coverage.photo.content_hash &&
        phraseCovered(
          `${firstText(item.label)} ${firstText(item.notes)}`,
          bundle.coverage.photo.scope_phrase,
        )
      );
      if (!row) return [];
      const type = mediaType(row, "image/jpeg");
      if (type !== "image/jpeg" && type !== "image/png") return [];
      const url = artifactUrl(row);
      if (!url) return [];
      try {
        const bytes = await fetchBytes(url, "bundled sibling photo");
        if (
          await rawPhotoSha256(bytes) !== bundle.coverage.photo.content_hash
        ) {
          return [];
        }
        return [{
          photo_id: text(row.id),
          source_pointer: `job_media:${text(row.id)}`,
          file_name: fileName(row, `${bundle.sibling.job_number}-photo.jpg`),
          media_type: type,
          bytes,
        }];
      } catch {
        return [];
      }
    },
    // U4 generates its own SWMS; it does not reuse a staff-attached PDF. The
    // preparer has already run `buildSesSwmsGenerationPlan`, which fails closed
    // with `swms_generation_facts_missing` unless every required real fact -
    // crew included - is present in the work order, bound field report, job or
    // assignment. Binding the renderer directly (rather than wrapping it) keeps
    // the bytes the docket hashes identical to the bytes the renderer produced.
    renderSwmsArtifact: renderSesSwmsPdf,
    // Superseded by the line above and deliberately left unconsumed by
    // `prepare_ses_docket_revision`: reusing a staff-attached SWMS was rejected
    // in #432 because a stale attachment violates the current-cycle input
    // contract. See the DEFECT DOCUMENTATION test in the adapter suite.
    resolveSwmsArtifact: async (input) => {
      const snapshot = snapshotFor(input);
      let row = snapshot.documents.find(
        (item) => text(item.type).toLowerCase() === "swms",
      );
      const bundle = input.sibling_bundle_evidence;
      if (!row && bundle?.status === "accepted") {
        row = (snapshot.bundle_documents || []).find((item) =>
          text(item.id) === bundle.coverage.swms_document_id &&
          text(item.job_id) === bundle.sibling.job_id &&
          text(item.type).toLowerCase() === "swms"
        );
      }
      if (!row) return null;
      const url = artifactUrl(row);
      if (!url) return null;
      try {
        return {
          file_name: fileName(row, "SWMS.pdf"),
          media_type: "application/pdf",
          bytes: await fetchBytes(url, "SWMS"),
        };
      } catch {
        return null;
      }
    },
    persist: createSesDocketPersistenceAdapter({
      client,
      org_id: options.org_id,
      created_by: options.created_by,
    }),
  };
}

export function normalizeSesPrepareRequest(
  body: Record<string, unknown>,
): SesPrepareRequest {
  if (typeof body?.dry_run !== "boolean") {
    throw new SesAssemblerAdapterError(
      "ses_dry_run_required",
      "dry_run must be explicitly true or false.",
      400,
    );
  }
  const idempotencyKey = text(body?.idempotency_key);
  if (!idempotencyKey) {
    throw new SesAssemblerAdapterError(
      "ses_idempotency_key_required",
      "idempotency_key is required.",
      400,
    );
  }
  if (
    body?.assembler_version &&
    body.assembler_version !== SES_ASSEMBLER_VERSION
  ) {
    throw new SesAssemblerAdapterError(
      "ses_assembler_version_unsupported",
      `assembler_version must be ${SES_ASSEMBLER_VERSION}.`,
      400,
    );
  }
  const selection = record(body?.selection);
  const mode = text(selection.mode);
  const jobId = text(selection.job_id);
  const jobNumber = text(selection.job_number);
  const limit = Number(selection.limit);
  const valid = mode === "job_id"
    ? !!jobId && !jobNumber && selection.limit == null
    : mode === "job_number"
    ? !!jobNumber && !jobId && selection.limit == null
    : mode === "board_batch"
    ? !jobId &&
      !jobNumber &&
      Number.isSafeInteger(limit) &&
      limit >= 1 &&
      limit <= 50
    : false;
  if (!valid) {
    throw new SesAssemblerAdapterError(
      "ses_selection_invalid",
      "selection must be exactly one job_id, job_number, or board_batch limit from 1 to 50.",
      400,
    );
  }
  return {
    selection: mode === "job_id"
      ? { mode, job_id: jobId }
      : mode === "job_number"
      ? { mode, job_number: jobNumber }
      : { mode: "board_batch", limit },
    idempotency_key: idempotencyKey,
    assembler_version: SES_ASSEMBLER_VERSION,
    dry_run: body.dry_run,
    force_refresh: body?.force_refresh === true,
    ...(body?.require_ready_for_persistence === true
      ? { require_ready_for_persistence: true }
      : {}),
    ...(body.expected_physical_report_proof &&
        typeof body.expected_physical_report_proof === "object" &&
        !Array.isArray(body.expected_physical_report_proof)
      ? {
        expected_physical_report_proof: body
          .expected_physical_report_proof as SesPhysicalReportProof,
      }
      : {}),
  };
}
