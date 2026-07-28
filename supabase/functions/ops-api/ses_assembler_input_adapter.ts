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
  type SesPreparedRevision,
  type SesPrepareRequest,
  type SesSha256,
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
  filterMediaForCurrentCycle,
  selectCurrentCycleReport,
} from "./makesafe_cycle_evidence.ts";
import { extractPortalLinks } from "./makesafe_portal_guard.ts";
import {
  SES_ASSESSMENT_RECIPE_VERSION,
  type SesPhotoArtifact,
  type SesPhotoProof,
  type SesPrepareDependencies,
  type SesPrepareResponse,
} from "./ses_prepare_docket_revision.ts";
import { createSesDocketPersistenceAdapter } from "./ses_docket_persistence.ts";
import {
  type MakesafeReportJob,
  renderMakesafeReportPdf,
} from "./makesafe_report_render.ts";
import {
  renderRoofReportPdf,
  type RoofReportJob,
} from "./roof_report_render.ts";
import { buildRoofReportJob } from "./roof_report_template.ts";

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
  legacy_packs: LiveRow[];
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

function hasExplicitValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "boolean";
}

function reportText(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (item && typeof item === "object") return JSON.stringify(item);
        return String(item ?? "").trim();
      })
      .filter(Boolean)
      .join(", ");
  }
  if (value && typeof value === "object") return JSON.stringify(value);
  return text(value);
}

function tradeCountLabel(value: unknown): string {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return "";
  return `${count} ${count === 1 ? "trade" : "trades"}`;
}

function reportedLabourNote(labourHours: unknown, tradeCount: unknown): string {
  const hours = Number(labourHours);
  if (!Number.isFinite(hours) || hours <= 0) return "";
  const trades = Number(tradeCount);
  const tradeNote = Number.isFinite(trades) && trades > 0
    ? ` and ${tradeCountLabel(trades)}`
    : "";
  return `Trade submission recorded ${hours} labour ${
    hours === 1 ? "hour" : "hours"
  }${tradeNote}.`;
}

function attendanceDate(value: unknown): string {
  const candidate = text(value);
  const match = candidate.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || candidate;
}

function attendanceTime(value: unknown): string {
  const candidate = text(value);
  const match = candidate.match(/(?:T|\s)(\d{2}:\d{2})(?::\d{2})?/);
  return match?.[1] || candidate;
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
):
  | "roof_report"
  | "assessment"
  | "photos"
  | "scope"
  | "builder_portal"
  | "other" {
  const role = rawRole.toLowerCase();
  if (familyId === "ordinary_roof_portal") return "roof_report";
  if (role.includes("photo")) return "photos";
  if (role.includes("scope") || role.includes("quote")) return "scope";
  if (role.includes("assessment") || role.includes("report")) {
    return "assessment";
  }
  if (role.includes("portal")) return "builder_portal";
  return "other";
}

function explicitHoursAndMaterials(
  snapshot: SesAssemblerLiveSnapshot,
  currentReport: LiveRow | null,
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
  copy("storeys", snapshot.roof_draft?.storey, roofFields.storeys);
  copy(
    "trades",
    pricing.trades,
    completion.trades,
    checklist.trades,
    checklist.trade_count,
  );
  // submit_makesafe_report's legacy labour_hours field is documented as
  // ambiguous between total hours and hours per trade. Preserve it in the raw
  // trade report and report prose, but only price an explicitly typed
  // hours_per_trade value.
  copy(
    "hours_per_trade",
    pricing.hours_per_trade,
    completion.hours_per_trade,
    checklist.hours_per_trade,
  );
  copy("rate_ex_gst", pricing.rate_ex_gst, checklist.rate_ex_gst);
  copy("panel_count", pricing.panel_count, checklist.panel_count);
  copy("base_count", pricing.base_count, checklist.base_count);
  copy(
    "star_picket_count",
    pricing.star_picket_count,
    checklist.star_picket_count,
  );
  if (typeof pricing.fence_only === "boolean") {
    facts.fence_only = pricing.fence_only;
  } else if (typeof checklist.fence_only === "boolean") {
    facts.fence_only = checklist.fence_only;
  }
  const materials = array(pricing.materials).length
    ? array(pricing.materials)
    : array(checklist.materials);
  if (materials.length) facts.materials = materials;
  return Object.keys(facts).length ? facts : null;
}

export function physicalReportRenderJob(
  snapshot: SesAssemblerLiveSnapshot,
  input: SesAssemblerInputV1,
  photoArtifacts: SesPhotoArtifact[] = [],
): MakesafeReportJob {
  const report = record(input.cycle_facts.trade_report);
  const checklist = record(report.checklist_json);
  const assignment = snapshot.assignments[0] || {};
  const attendance = firstText(
    checklist.attendance_date,
    checklist.arrival_time,
    assignment.arrived_at,
    report.submitted_at,
    assignment.scheduled_date,
  );
  const materials = firstText(
    reportText(checklist.materials),
    reportText(checklist.materials_used),
  );
  const accessIssues = Object.hasOwn(checklist, "access_issues")
    ? reportText(checklist.access_issues) || "No access issues reported."
    : "Access constraints: not recorded in trade submission.";
  const followUpRequired = !Object.hasOwn(checklist, "follow_up_required")
    ? "Follow-up status: not recorded in trade submission."
    : checklist.follow_up_required === true
    ? "Follow-up required."
    : checklist.follow_up_required === false
    ? "No further works required."
    : reportText(checklist.follow_up_required) ||
      "Follow-up status: not recorded in trade submission.";
  return {
    ref: input.source.builder_reference,
    address: input.source.site_address || "Address not recorded",
    contact: firstText(snapshot.job.client_name),
    date: attendanceDate(attendance),
    arrival: attendanceTime(
      firstText(assignment.arrived_at, checklist.arrival_time),
    ),
    crew: firstText(
      assignment.crew_name,
      tradeCountLabel(checklist.trade_count),
    ),
    billing_note: firstText(
      checklist.billing_note,
      checklist.invoice_notes,
      reportedLabourNote(checklist.labour_hours, checklist.trade_count),
    ),
    scope: firstText(
      checklist.scope,
      input.source.instruction_text,
      checklist.damage_description,
    ),
    findings: firstText(checklist.findings, checklist.damage_cause),
    works: firstText(
      checklist.works_completed,
      checklist.works,
      checklist.work_done,
      report.notes,
    ),
    materials,
    access_issues: accessIssues,
    follow_up_required: followUpRequired,
    photos: photoArtifacts.map((photo) => {
      const source = input.cycle_facts.photos.find(
        (item) =>
          item.id === photo.photo_id &&
          item.path_or_key === photo.source_pointer,
      );
      let binary = "";
      for (const byte of photo.bytes) binary += String.fromCharCode(byte);
      return {
        bytesBase64: btoa(binary),
        contentType: photo.media_type,
        caption: source?.caption,
      };
    }),
  };
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
  const reportOnly = [
    "ordinary_roof_portal",
    "own_template_roof",
    "assessment_quote",
  ].includes(familyId);
  const matrix = resolveSesFamilyMatrixRow({
    builder_key: builder,
    family: familyId,
    strata: familyId === "own_template_roof",
    own_template_requested: familyId === "own_template_roof",
  });
  const builderReference = firstText(
    intakeCase?.builder_wo_canonical,
    intakeCase?.builder_po_canonical,
    intakeCase?.external_ref_canonical,
    identityRevision ? detail.external_ref : null,
    identityRevision ? metadata.external_ref : null,
  );
  const portalLinks = extractPortalLinks(detail.external_links).map((link) => ({
    role: portalRole(familyId, link.role),
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
      subtype: familyId === "temporary_fencing" ? "temporary_fencing" : null,
      report_only: reportOnly,
      report_delivery: familyId === "ordinary_roof_portal"
        ? "portal"
        : familyId === "own_template_roof"
        ? "own_document"
        : null,
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
      hours_and_materials: explicitHoursAndMaterials(snapshot, report),
      prior_release: {
        released: !!priorPack,
        release_revision_id: text(priorPack?.id) || null,
        cycle_set_hash: text(priorPack?.makesafe_content_hash) || null,
      },
    },
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
    packs,
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
        .select("*")
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
      client.from("makesafe_report_packs").select("*").eq("job_id", jobId),
      "makesafe_report_packs",
    ),
  ]);
  const caseMap = new Map<string, LiveRow>();
  for (const item of [...casesByJob, ...casesByTarget]) {
    if (text(item.id)) caseMap.set(text(item.id), item);
  }
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
    legacy_packs: packs,
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
    renderPhysicalReport: async (input, photos = []) => {
      const snapshot = snapshotFor(input);
      const rendered = await renderMakesafeReportPdf(
        physicalReportRenderJob(snapshot, input, photos),
      );
      return {
        file_name: rendered.fileName,
        media_type: "application/pdf",
        bytes: rendered.bytes,
        render_hash: rendered.renderHash,
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
    resolveSwmsArtifact: async (input) => {
      const snapshot = snapshotFor(input);
      const row = snapshot.documents.find(
        (item) => text(item.type).toLowerCase() === "swms",
      );
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
  };
}
