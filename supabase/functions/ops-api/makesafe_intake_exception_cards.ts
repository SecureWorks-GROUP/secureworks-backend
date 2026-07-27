// deno-lint-ignore-file no-explicit-any
//
// U2 intake-exception visibility seam.
//
// This is a read model only. It resolves the append-only case/source authority
// overlays, accounts instructions already covered by a live job, and emits a
// human-review card only when deterministic evidence proves a real builder work
// order but no live job exists. It never creates a case, draft, job, assignment,
// communication, or gap-fill row.

import {
  canonicalCompanyDedupeKey,
  canonicalExternalObligationRef,
  canonicalObligationPoCore,
  loadRefPrefixes,
} from "../_shared/makesafe_refs.ts";
import { isReportOnlyType } from "./makesafe_intake_gate.ts";
import {
  type IntakeOperationalFact,
  loadIntakeOperationalFacts,
} from "./makesafe_intake_operational_facts.ts";
import { GAP_FILL_ALLOWED_FIELDS } from "./makesafe_gap_fill.ts";

const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000001";
const DEFAULT_MAILBOX = "ses@secureworkswa.com.au";
const PAGE_SIZE = 500;
const ID_CHUNK_SIZE = 25;
export const INTAKE_EXCEPTION_RECENT_WINDOW_DAYS = 15;

export const INTAKE_EXCEPTION_CARD_CONTRACT_VERSION =
  "makesafe-intake-exception-cards.v1";

export type IntakeExceptionDisposition =
  | "visible_review_card"
  | "bound_live_job"
  | "existing_job_follow_up"
  | "duplicate_shadow"
  | "correction_residue"
  | "deterministic_non_work"
  | "lineage_update"
  | "out_of_window"
  | "ambiguous_for_reporting";

export interface IntakeExceptionDispositionRecord {
  case_id: string;
  external_ref: string | null;
  disposition: IntakeExceptionDisposition;
  display_reason_code: string;
  related_job_id: string | null;
  card_id: string | null;
}

export interface IntakeExceptionEvidenceSource {
  post_id: string;
  role: string | null;
  received_at: string | null;
  subject: string | null;
  from_email: string | null;
  from_name: string | null;
  attachments: Array<{
    attachment_id: string;
    name: string | null;
    content_type: string | null;
    status: string | null;
    size_bytes: number | null;
    is_pdf: boolean;
  }>;
}

export interface IntakeExceptionAction {
  verb:
    | "fill gap"
    | "review source"
    | "builder must resend"
    | "chase portal";
  route:
    | "makesafe_gap_fill_queue"
    | "intake_source_review"
    | "builder_resend_request"
    | "makesafe_portal_recheck_queue";
  case_ids: string[];
}

export interface IntakeExceptionCard {
  id: string;
  kind: "intake_exception";
  status: "source-backed, no job - needs review";
  case_id: string;
  case_ids: string[];
  job_id: null;
  builder: {
    id: string | null;
    slug: string | null;
    name: string | null;
  };
  external_ref: string;
  received_at: string;
  source_email_subject: string | null;
  blocker_sentence: string;
  needed_information: string[];
  case_gaps: Array<{
    case_id: string;
    needed_information: string[];
  }>;
  evidence_sources: IntakeExceptionEvidenceSource[];
  attachment_pointers: Array<{
    post_id: string;
    attachment_id: string;
    name: string | null;
    content_type: string | null;
    status: string | null;
    size_bytes: number | null;
    is_pdf: boolean;
  }>;
  next_action: IntakeExceptionAction;
  available_actions: IntakeExceptionAction[];
  human_review_required: true;
  human_approval_required: true;
  auto_create_job: false;
  auto_create_draft: false;
}

export interface IntakeSourceAlarm {
  id: string;
  kind: "intake_source_alarm";
  source_post_id: string;
  received_at: string;
  blocker_sentence: string;
  next_action: string;
  severity: IntakeOperationalFact["severity"];
  subject: string | null;
  attachments: IntakeExceptionEvidenceSource["attachments"];
}

export interface IntakeExceptionProjection {
  contract_version: typeof INTAKE_EXCEPTION_CARD_CONTRACT_VERSION;
  generated_at: string;
  org_id: string;
  recent_window: {
    days: typeof INTAKE_EXCEPTION_RECENT_WINDOW_DAYS;
    from: string;
    to: string;
  };
  summary: {
    visible_actionable_cards: number;
    resolved_from_existing_evidence: number;
    accounted_silently: number;
    outside_three: number;
  };
  totals: {
    exception_case_rows: number;
    recent_exception_case_rows: number;
    out_of_window_exception_case_rows: number;
    recent_accounted_non_work_rows: number;
    recent_deterministic_non_work_exception_rows: number;
    actionable_case_rows: number;
    cards: number;
    source_alarms: number;
  };
  disposition_counts: Record<IntakeExceptionDisposition, number>;
  cards: IntakeExceptionCard[];
  source_alarms: IntakeSourceAlarm[];
  dispositions: IntakeExceptionDispositionRecord[];
}

export interface IntakeExceptionCaseRow {
  id: string;
  company_id: string | null;
  company_slug_raw: string | null;
  external_ref_raw: string | null;
  external_ref_canonical: string | null;
  builder_wo_canonical: string | null;
  builder_po_canonical: string | null;
  wo_po_identity_key: string | null;
  raw_identity_json: Record<string, unknown> | null;
  story_json: unknown;
  evidence_map: Record<string, unknown> | null;
  state: string;
  reason_code: string | null;
  missing_fields: string[] | null;
  conflicting_fields: Record<string, unknown> | null;
  parent_case_id: string | null;
  parent_relation: string | null;
  target_relation: string | null;
  job_id: string | null;
  target_job_id: string | null;
  client_name: string | null;
  client_phone: string | null;
  client_email: string | null;
  site_address: string | null;
  site_suburb: string | null;
  received_at: string;
}

export interface IntakeExceptionSourceRow {
  case_id: string;
  post_id: string;
  role: string | null;
  received_at: string | null;
  attachment_refs: unknown;
}

export interface IntakeSourceAuthorityCorrectionRow {
  id: string;
  source_post_id: string;
  legacy_case_id: string | null;
  effective_case_id: string | null;
  target_job_id: string | null;
}

export interface IntakeSourceAuthoritySupersessionRow {
  source_post_id: string;
  superseded_correction_id: string;
  prior_authority_case_id: string;
  effective_case_id: string;
}

export interface IntakeCaseAuthorityCorrectionRow {
  legacy_case_id: string;
  effective_case_id: string | null;
}

export interface IntakeExceptionJobRow {
  job_id: string;
  external_ref: string | null;
  requesting_company_slug: string | null;
  requesting_company_name: string | null;
  report_type: string | null;
  jobs:
    | {
      id?: string;
      status?: string | null;
      site_address?: string | null;
      type?: string | null;
      metadata?: Record<string, unknown> | null;
    }
    | Array<{
      id?: string;
      status?: string | null;
      site_address?: string | null;
      type?: string | null;
      metadata?: Record<string, unknown> | null;
    }>
    | null;
}

export interface IntakeExceptionProjectionInput {
  orgId: string;
  generatedAt: string;
  facts: IntakeOperationalFact[];
  cases: IntakeExceptionCaseRow[];
  sources: IntakeExceptionSourceRow[];
  sourceCorrections: IntakeSourceAuthorityCorrectionRow[];
  sourceSupersessions: IntakeSourceAuthoritySupersessionRow[];
  caseCorrections: IntakeCaseAuthorityCorrectionRow[];
  companies: Array<{ id: string; slug: string | null; name: string | null }>;
  jobs: IntakeExceptionJobRow[];
  emails: Array<{
    post_id: string;
    subject: string | null;
    from_email: string | null;
    from_name: string | null;
    received_at: string | null;
  }>;
  attachments: Array<{
    id: string;
    email_id: string;
    name: string | null;
    content_type: string | null;
    status: string | null;
    size_bytes: number | null;
  }>;
  excludedPostIds: string[];
  refPrefixes: string[];
}

interface EffectiveSource {
  source: IntakeExceptionSourceRow;
  storedCaseId: string;
  effectiveCaseId: string | null;
  targetJobId: string | null;
}

const DEAD_JOB_STATUSES = new Set([
  "cancelled",
  "canceled",
  "void",
  "voided",
  "superseded",
]);

const DETERMINISTIC_NON_WORK_REASONS = new Set([
  "cancellation",
  "cancellation_target_not_found",
  "cancellation_target_ambiguous",
  "cancellation_live_invoice_review",
  "cancellation_target_terminal_conflict",
  "cancellation_apply_failed",
  "duplicate",
  "revision",
  "non_makesafe",
]);

function cleanStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.map((item) => String(item ?? "").trim()).filter(Boolean),
    ),
  ].sort();
}

export function plainIntakeField(field: string): string {
  const known: Record<string, string> = {
    client_name: "client name",
    client_phone: "client phone",
    client_email: "client email",
    site_address: "site address",
    site_suburb: "site suburb",
    external_ref: "external reference",
    external_reference: "external reference",
    builder_work_order: "builder work order number",
    purchase_order: "purchase order number",
    work_order_attachment: "work order attachment",
    work_order_pdf: "work order PDF",
    portal_capture: "portal capture",
  };
  return known[field] || field.replaceAll("_", " ");
}

function nonEmpty(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(nonEmpty);
  if (typeof value === "boolean") return value;
  return value !== null && value !== undefined &&
    String(value).trim().length > 0;
}

function fieldAlreadyHeld(
  row: IntakeExceptionCaseRow,
  field: string,
  hasWorkOrderAttachment: boolean,
): boolean {
  const raw = row.raw_identity_json || {};
  const direct: Record<string, unknown[]> = {
    client_name: [row.client_name, raw.client_name, raw.clientName],
    client_phone: [row.client_phone, raw.client_phone, raw.clientPhone],
    client_email: [row.client_email, raw.client_email, raw.clientEmail],
    site_address: [row.site_address, raw.site_address, raw.siteAddress],
    site_suburb: [row.site_suburb, raw.site_suburb, raw.siteSuburb],
    external_ref: [
      row.external_ref_canonical,
      row.external_ref_raw,
      raw.external_ref,
      raw.externalRef,
    ],
    external_reference: [
      row.external_ref_canonical,
      row.external_ref_raw,
      raw.external_ref,
      raw.externalRef,
    ],
    builder_work_order: [
      row.builder_wo_canonical,
      raw.builder_wo,
      raw.builderWo,
    ],
    purchase_order: [
      row.builder_po_canonical,
      raw.builder_po,
      raw.builderPo,
    ],
    work_order_attachment: [
      hasWorkOrderAttachment,
      raw.work_order_pdf_text,
      raw.workOrderPdfText,
    ],
    work_order_pdf: [
      hasWorkOrderAttachment,
      raw.work_order_pdf_text,
      raw.workOrderPdfText,
    ],
  };
  if ((direct[field] || []).some(nonEmpty)) return true;
  const evidence = row.evidence_map?.[field];
  return !!evidence && typeof evidence === "object" &&
    String((evidence as Record<string, unknown>).status || "") === "satisfied";
}

function neededFieldCodesFor(
  row: IntakeExceptionCaseRow,
  hasWorkOrderAttachment: boolean,
  heldElsewhere = new Set<string>(),
): string[] {
  return cleanStrings(row.missing_fields)
    .filter((field) =>
      !heldElsewhere.has(field) &&
      !fieldAlreadyHeld(row, field, hasWorkOrderAttachment)
    );
}

function joinPlainList(values: string[]): string {
  if (values.length < 2) return values[0] || "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

export function intakeBlockerSentence(neededInformation: string[]): string {
  if (!neededInformation.length) {
    return "Review and approve this source-backed work order before a job can be created.";
  }
  if (
    neededInformation.length === 1 &&
    neededInformation[0] === "portal capture"
  ) {
    return "Capture the builder portal details before approving this work order.";
  }
  if (
    neededInformation.includes("work order attachment") ||
    neededInformation.includes("work order PDF")
  ) {
    return `The builder must resend ${
      joinPlainList(neededInformation)
    } before this work order can be approved.`;
  }
  return `Add ${
    joinPlainList(neededInformation)
  } before approving this work order.`;
}

function plainCode(value: string | null, fallback: string): string {
  const plain = String(value || "").trim().replaceAll("_", " ");
  return plain || fallback;
}

function sourceAlarmBlockerSentence(fact: IntakeOperationalFact): string {
  const known: Record<string, string> = {
    pdf_attachment_limit:
      "The work order attachment could not be fully read within the intake limit.",
    intake_exception_scan_completed_without_case_fate:
      "Intake finished without deciding whether this source is work.",
    intake_exception_scan_handoff_failed:
      "The intake handoff failed before this source received a final outcome.",
  };
  return known[String(fact.reason_code || "")] ||
    `This source still needs review: ${
      plainCode(fact.reason_code, "intake did not record a final outcome")
    }.`;
}

function sourceAlarmNextAction(fact: IntakeOperationalFact): string {
  const known: Record<string, string> = {
    retry_bounded_pdf_extraction:
      "Review the attachment and retry bounded PDF extraction.",
    review_source: "Review the source and record its final outcome.",
  };
  return known[String(fact.next_action_code || "")] ||
    `Review the source and ${
      plainCode(fact.next_action_code, "record its final outcome")
    }.`;
}

function adapterGenuinelyCrashed(row: IntakeExceptionCaseRow): boolean {
  const raw = row.raw_identity_json || {};
  if (raw.adapter_crashed === true) return true;
  const evidence = row.evidence_map || {};
  const adapter = evidence.adapter || evidence.adapter_failure;
  if (
    adapter && typeof adapter === "object" &&
    ["crashed", "exception", "runtime_error"].includes(
      String((adapter as Record<string, unknown>).status || "").toLowerCase(),
    )
  ) return true;
  return Array.isArray(row.story_json) &&
    row.story_json.some((event) =>
      event && typeof event === "object" &&
      ["adapter_crashed", "adapter_runtime_error"].includes(
        String((event as Record<string, unknown>).summaryCode || ""),
      )
    );
}

export function honestIntakeReason(
  row: IntakeExceptionCaseRow,
): string {
  const missing = cleanStrings(row.missing_fields);
  if (missing.length === 1 && missing[0] === "portal_capture") {
    return "missing_portal_capture";
  }
  if (missing.length === 1) return `missing_${missing[0]}`;
  if (missing.length > 1) return "missing_required_fields";
  if (Object.keys(row.conflicting_fields || {}).length) {
    return "conflicting_fields";
  }
  if (
    row.reason_code === "adapter_parse_failure" &&
    adapterGenuinelyCrashed(row)
  ) return "adapter_parse_failure";
  if (row.reason_code === "adapter_parse_failure") {
    return "source_needs_review";
  }
  return row.reason_code || "source_needs_review";
}

function jobRecord(row: IntakeExceptionJobRow) {
  return Array.isArray(row.jobs) ? row.jobs[0] || null : row.jobs;
}

function numericCore(value: unknown): string | null {
  return String(value ?? "").match(/\d{5,}/g)?.[0] ?? null;
}

function addressKey(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\bwa\b/g, " ")
    .replace(/\b\d{4}\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function addressesMatch(left: unknown, right: unknown): boolean {
  const a = addressKey(left);
  const b = addressKey(right);
  if (!a || !b) return false;
  return a === b ||
    (a.length >= 12 && b.length >= 12 &&
      (a.includes(b) || b.includes(a)));
}

function isReportOnlyCase(row: IntakeExceptionCaseRow): boolean {
  const identity = row.raw_identity_json || {};
  return isReportOnlyType(
    String(
      identity.deliverable || identity.job_family || identity.report_type ||
        "",
    ),
  );
}

/**
 * Mirrors deterministic intake's existing-obligation boundary. A match is
 * builder-scoped, deliverable-scoped, live-only, and preserves explicit PO
 * discrimination. It returns every exact match so ambiguity can be accounted
 * without guessing.
 */
export function matchingLiveObligationJobIds(
  row: IntakeExceptionCaseRow,
  company: { slug: string | null; name: string | null } | null,
  jobs: IntakeExceptionJobRow[],
  prefixes: readonly string[],
): string[] {
  const targetCompany = canonicalCompanyDedupeKey(
    company?.slug || row.company_slug_raw || company?.name,
  );
  const targetRef = canonicalExternalObligationRef(
    row.external_ref_canonical || row.builder_wo_canonical ||
      row.external_ref_raw,
    prefixes,
  );
  const targetPo = canonicalObligationPoCore(row.builder_po_canonical) ||
    canonicalObligationPoCore(row.builder_wo_canonical, true) ||
    canonicalObligationPoCore(row.external_ref_canonical, true);
  if (!targetCompany || (!targetRef && !row.builder_wo_canonical)) return [];

  const matches = jobs.filter((candidate) => {
    if (!candidate?.job_id) return false;
    const existingCompany = canonicalCompanyDedupeKey(
      candidate.requesting_company_slug ||
        candidate.requesting_company_name,
    );
    if (!existingCompany || existingCompany !== targetCompany) return false;
    if (
      isReportOnlyType(candidate.report_type) !== isReportOnlyCase(row)
    ) return false;
    const existingJob = jobRecord(candidate);
    if (!existingJob?.id) return false;
    if (existingJob?.type && existingJob.type !== "makesafe") return false;
    if (
      DEAD_JOB_STATUSES.has(
        String(existingJob?.status || "").trim().toLowerCase(),
      )
    ) return false;

    const metadata =
      existingJob?.metadata && typeof existingJob.metadata === "object"
        ? existingJob.metadata
        : {};
    const existingRef = canonicalExternalObligationRef(
      candidate.external_ref,
      prefixes,
    );
    const exactRefMatch = !!targetRef && existingRef === targetRef;
    const exactWoMatch = !!row.builder_wo_canonical &&
      canonicalExternalObligationRef(
          metadata.builder_work_order_number as string | null,
          prefixes,
        ) ===
        canonicalExternalObligationRef(row.builder_wo_canonical, prefixes);
    const exactPoMatch = !!row.builder_po_canonical &&
      canonicalObligationPoCore(metadata.builder_po_number) ===
        canonicalObligationPoCore(row.builder_po_canonical);
    const targetRefCore = numericCore(targetRef);
    const builderScopedBareRefMatch = !!row.site_address &&
      targetRefCore !== null &&
      targetRefCore === numericCore(existingRef) &&
      addressesMatch(row.site_address, existingJob?.site_address);
    if (
      !exactRefMatch && !exactWoMatch && !exactPoMatch &&
      !builderScopedBareRefMatch
    ) return false;

    const existingPo = canonicalObligationPoCore(metadata.builder_po_number) ||
      canonicalObligationPoCore(
        metadata.builder_work_order_number,
        true,
      ) ||
      canonicalObligationPoCore(candidate.external_ref, true);
    return !(targetPo && existingPo && targetPo !== existingPo);
  });
  return [...new Set(matches.map((candidate) => String(candidate.job_id)))]
    .sort();
}

function resolveEffectiveSources(
  input: IntakeExceptionProjectionInput,
): EffectiveSource[] {
  const storedCaseByPost = new Map<string, string>();
  for (const source of input.sources) {
    const prior = storedCaseByPost.get(source.post_id);
    if (prior && prior !== source.case_id) {
      throw new Error(
        `intake source authority is not unique for post ${source.post_id}`,
      );
    }
    storedCaseByPost.set(source.post_id, source.case_id);
  }
  const correctionByPost = new Map<
    string,
    IntakeSourceAuthorityCorrectionRow
  >();
  for (const correction of input.sourceCorrections) {
    if (correctionByPost.has(correction.source_post_id)) {
      throw new Error(
        `intake source correction is not unique for post ${correction.source_post_id}`,
      );
    }
    const stored = storedCaseByPost.get(correction.source_post_id) || null;
    if (correction.legacy_case_id && stored !== correction.legacy_case_id) {
      throw new Error(
        "intake source correction legacy authority mismatch",
      );
    }
    correctionByPost.set(correction.source_post_id, correction);
  }
  const supersessionByPost = new Map<
    string,
    IntakeSourceAuthoritySupersessionRow
  >();
  for (const supersession of input.sourceSupersessions) {
    if (supersessionByPost.has(supersession.source_post_id)) {
      throw new Error(
        `intake source supersession is not unique for post ${supersession.source_post_id}`,
      );
    }
    supersessionByPost.set(supersession.source_post_id, supersession);
  }

  return input.sources.map((source) => {
    const correction = correctionByPost.get(source.post_id) || null;
    // A correction with effective_case_id=NULL deliberately clears case
    // authority (usually because target_job_id accounts the source). Do not
    // collapse that reviewed NULL back to the stale stored case.
    let effectiveCaseId: string | null = correction
      ? correction.effective_case_id
      : source.case_id;
    const supersession = supersessionByPost.get(source.post_id) || null;
    if (supersession) {
      if (
        !correction ||
        correction.id !== supersession.superseded_correction_id
      ) {
        throw new Error("intake source supersession target mismatch");
      }
      if (effectiveCaseId !== supersession.prior_authority_case_id) {
        throw new Error("intake source supersession prior authority mismatch");
      }
      effectiveCaseId = supersession.effective_case_id;
    }
    return {
      source,
      storedCaseId: source.case_id,
      effectiveCaseId,
      targetJobId: correction?.target_job_id || null,
    };
  });
}

function evidenceSources(
  sourceRows: IntakeExceptionSourceRow[],
  emailByPost: Map<string, IntakeExceptionProjectionInput["emails"][number]>,
  attachmentsByPost: Map<
    string,
    IntakeExceptionProjectionInput["attachments"]
  >,
): IntakeExceptionEvidenceSource[] {
  return [...sourceRows]
    .sort((a, b) =>
      String(a.received_at || "").localeCompare(String(b.received_at || "")) ||
      a.post_id.localeCompare(b.post_id)
    )
    .map((source) => {
      const email = emailByPost.get(source.post_id) || null;
      return {
        post_id: source.post_id,
        role: source.role || null,
        received_at: source.received_at || email?.received_at || null,
        subject: email?.subject || null,
        from_email: email?.from_email || null,
        from_name: email?.from_name || null,
        attachments: (attachmentsByPost.get(source.post_id) || [])
          .map((attachment) => ({
            attachment_id: attachment.id,
            name: attachment.name || null,
            content_type: attachment.content_type || null,
            status: attachment.status || null,
            size_bytes: attachment.size_bytes ?? null,
            is_pdf: /pdf/i.test(attachment.content_type || "") ||
              /\.pdf$/i.test(attachment.name || ""),
          }))
          .sort((a, b) => a.attachment_id.localeCompare(b.attachment_id)),
      };
    });
}

function actionsFor(
  caseIds: string[],
  missingFields: string[],
): IntakeExceptionAction[] {
  const actions: IntakeExceptionAction[] = [];
  const missing = new Set(missingFields);
  if (
    GAP_FILL_ALLOWED_FIELDS.some((field) => missing.has(field))
  ) {
    actions.push({
      verb: "fill gap",
      route: "makesafe_gap_fill_queue",
      case_ids: caseIds,
    });
  }
  if (missing.has("portal_capture")) {
    actions.push({
      verb: "chase portal",
      route: "makesafe_portal_recheck_queue",
      case_ids: caseIds,
    });
  }
  if (
    missing.has("work_order_attachment") ||
    missing.has("work_order_pdf")
  ) {
    actions.push({
      verb: "builder must resend",
      route: "builder_resend_request",
      case_ids: caseIds,
    });
  }
  actions.push({
    verb: "review source",
    route: "intake_source_review",
    case_ids: caseIds,
  });
  return actions;
}

function emptyDispositionCounts(): Record<IntakeExceptionDisposition, number> {
  return {
    visible_review_card: 0,
    bound_live_job: 0,
    existing_job_follow_up: 0,
    duplicate_shadow: 0,
    correction_residue: 0,
    deterministic_non_work: 0,
    lineage_update: 0,
    out_of_window: 0,
    ambiguous_for_reporting: 0,
  };
}

function cardGroupKey(
  row: IntakeExceptionCaseRow,
  company: { slug: string | null; name: string | null } | null,
): string {
  const companyKey = canonicalCompanyDedupeKey(
    company?.slug || row.company_slug_raw || company?.name,
  );
  const obligation = row.wo_po_identity_key || row.builder_wo_canonical ||
    row.external_ref_canonical || row.id;
  // One builder obligation is one review card even when stale parser attempts
  // disagreed about deliverable. This is what coalesces AJBR-68554's three
  // exception attempts without merging distinct WO/PO identities.
  return `${companyKey}|${obligation}`;
}

/**
 * Pure projector. Every exception case receives exactly one disposition; only
 * strong, source-backed, jobless work reaches cards.
 */
export function buildIntakeExceptionProjection(
  input: IntakeExceptionProjectionInput,
): IntakeExceptionProjection {
  const generatedAtMs = Date.parse(input.generatedAt);
  if (!Number.isFinite(generatedAtMs)) {
    throw new Error("intake exception projection generatedAt must be ISO time");
  }
  const windowFromMs = generatedAtMs -
    INTAKE_EXCEPTION_RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const windowFrom = new Date(windowFromMs).toISOString();
  const isRecent = (receivedAt: string | null | undefined) => {
    const receivedAtMs = Date.parse(String(receivedAt || ""));
    return Number.isFinite(receivedAtMs) &&
      receivedAtMs >= windowFromMs &&
      receivedAtMs <= generatedAtMs;
  };
  const caseById = new Map(input.cases.map((row) => [row.id, row]));
  const companyById = new Map(
    input.companies.map((row) => [row.id, row]),
  );
  const caseCorrectionsByLegacy = new Map<string, Set<string | null>>();
  for (const correction of input.caseCorrections) {
    const effective = caseCorrectionsByLegacy.get(
      correction.legacy_case_id,
    ) || new Set<string | null>();
    effective.add(correction.effective_case_id);
    caseCorrectionsByLegacy.set(correction.legacy_case_id, effective);
  }
  const effectiveSources = resolveEffectiveSources(input);
  const effectiveSourcesByCase = new Map<string, EffectiveSource[]>();
  const storedSourcesByCase = new Map<string, EffectiveSource[]>();
  for (const source of effectiveSources) {
    const stored = storedSourcesByCase.get(source.storedCaseId) || [];
    stored.push(source);
    storedSourcesByCase.set(source.storedCaseId, stored);
    if (source.effectiveCaseId) {
      const effective = effectiveSourcesByCase.get(source.effectiveCaseId) ||
        [];
      effective.push(source);
      effectiveSourcesByCase.set(source.effectiveCaseId, effective);
    }
  }
  const exceptionCaseIds = new Set(
    input.cases.filter((row) => row.state === "exception").map((row) => row.id),
  );
  const dispositions: IntakeExceptionDispositionRecord[] = [];
  const visibleRows: IntakeExceptionCaseRow[] = [];
  const liveJobById = new Map(
    input.jobs.flatMap((row) => {
      const job = jobRecord(row);
      if (
        !job?.id ||
        DEAD_JOB_STATUSES.has(String(job.status || "").trim().toLowerCase())
      ) return [];
      return [[String(job.id), job] as const];
    }),
  );

  for (const caseId of exceptionCaseIds) {
    const row = caseById.get(caseId)!;
    const company = row.company_id
      ? companyById.get(row.company_id) || null
      : null;
    const effective = effectiveSourcesByCase.get(row.id) || [];
    const stored = storedSourcesByCase.get(row.id) || [];
    const correctedTargetJobs = [
      ...new Set(
        effective.concat(
          stored.filter((source) => source.effectiveCaseId === null),
        ).map((source) => source.targetJobId).filter((
          jobId,
        ): jobId is string => !!jobId && liveJobById.has(jobId)),
      ),
    ].sort();
    let disposition: IntakeExceptionDisposition;
    let relatedJobId: string | null = null;

    if (!isRecent(row.received_at)) {
      disposition = "out_of_window";
    } else if (row.job_id && liveJobById.has(row.job_id)) {
      disposition = "bound_live_job";
      relatedJobId = row.job_id;
    } else if (row.target_job_id && liveJobById.has(row.target_job_id)) {
      disposition = "existing_job_follow_up";
      relatedJobId = row.target_job_id;
    } else if (caseCorrectionsByLegacy.has(row.id)) {
      disposition = [...caseCorrectionsByLegacy.get(row.id)!].some(Boolean)
        ? "duplicate_shadow"
        : "correction_residue";
    } else if (correctedTargetJobs.length === 1) {
      disposition = "existing_job_follow_up";
      relatedJobId = correctedTargetJobs[0];
    } else if (correctedTargetJobs.length > 1) {
      disposition = "ambiguous_for_reporting";
    } else if (!effective.length && stored.length) {
      disposition = "duplicate_shadow";
    } else if (!effective.length) {
      disposition = "ambiguous_for_reporting";
    } else {
      const matches = matchingLiveObligationJobIds(
        row,
        company,
        input.jobs,
        input.refPrefixes,
      );
      if (matches.length === 1) {
        disposition = "existing_job_follow_up";
        relatedJobId = matches[0];
      } else if (matches.length > 1) {
        disposition = "ambiguous_for_reporting";
      } else {
        const deterministicNonWork = DETERMINISTIC_NON_WORK_REASONS.has(
          String(row.reason_code || ""),
        );
        // A canonical builder WO is the deterministic "this is real work"
        // floor. External ref alone is intentionally insufficient: weak or
        // ambiguous material remains accounted for the reporting skill.
        const strongRealWork = !!row.company_id &&
          !!row.builder_wo_canonical;
        disposition = deterministicNonWork
          ? "deterministic_non_work"
          : strongRealWork
          ? "visible_review_card"
          : row.parent_relation || row.target_relation
          ? "lineage_update"
          : "ambiguous_for_reporting";
        if (disposition === "visible_review_card") visibleRows.push(row);
      }
    }
    dispositions.push({
      case_id: row.id,
      external_ref: row.builder_wo_canonical ||
        row.external_ref_canonical || row.external_ref_raw || null,
      disposition,
      display_reason_code: honestIntakeReason(row),
      related_job_id: relatedJobId,
      card_id: null,
    });
  }

  const grouped = new Map<string, IntakeExceptionCaseRow[]>();
  for (const row of visibleRows) {
    const company = row.company_id
      ? companyById.get(row.company_id) || null
      : null;
    const key = cardGroupKey(row, company);
    grouped.set(key, [...(grouped.get(key) || []), row]);
  }
  const emailByPost = new Map(
    input.emails.map((row) => [row.post_id, row]),
  );
  const attachmentsByPost = new Map<
    string,
    IntakeExceptionProjectionInput["attachments"]
  >();
  for (const attachment of input.attachments) {
    attachmentsByPost.set(attachment.email_id, [
      ...(attachmentsByPost.get(attachment.email_id) || []),
      attachment,
    ]);
  }

  const cards: IntakeExceptionCard[] = [];
  for (const rows of grouped.values()) {
    rows.sort((a, b) =>
      a.received_at.localeCompare(b.received_at) || a.id.localeCompare(b.id)
    );
    const primary = rows[0];
    const caseIds = rows.map((row) => row.id);
    const company = primary.company_id
      ? companyById.get(primary.company_id) || null
      : null;
    const sourceRows = [
      ...new Map(
        rows.flatMap((row) =>
          (effectiveSourcesByCase.get(row.id) || []).map((source) =>
            [
              source.source.post_id,
              source.source,
            ] as const
          )
        ),
      ).values(),
    ];
    const evidence = evidenceSources(
      sourceRows,
      emailByPost,
      attachmentsByPost,
    );
    const hasWorkOrderAttachmentByCase = new Map(rows.map((row) => {
      const rowPostIds = new Set(
        (effectiveSourcesByCase.get(row.id) || []).map((entry) =>
          entry.source.post_id
        ),
      );
      const hasWorkOrderAttachment = evidence.some((source) =>
        rowPostIds.has(source.post_id) &&
        source.attachments.some((attachment) =>
          attachment.is_pdf &&
          !["failed", "error", "unavailable"].includes(
            String(attachment.status || "").toLowerCase(),
          )
        )
      );
      return [row.id, hasWorkOrderAttachment] as const;
    }));
    const allNamedFields = new Set(
      rows.flatMap((row) => cleanStrings(row.missing_fields)),
    );
    const heldElsewhere = new Set(
      [...allNamedFields].filter((field) =>
        rows.some((row) =>
          fieldAlreadyHeld(
            row,
            field,
            hasWorkOrderAttachmentByCase.get(row.id) || false,
          )
        )
      ),
    );
    const caseGapDetails = rows.map((row) => {
      const neededFieldCodes = neededFieldCodesFor(
        row,
        hasWorkOrderAttachmentByCase.get(row.id) || false,
        heldElsewhere,
      );
      return {
        row,
        neededFieldCodes,
        neededInformation: neededFieldCodes.map(plainIntakeField),
      };
    });
    const neededFieldCodes = [
      ...new Set(
        caseGapDetails.flatMap((detail) => detail.neededFieldCodes),
      ),
    ].sort();
    const neededInformation = neededFieldCodes.map(plainIntakeField);
    const actions = actionsFor(caseIds, neededFieldCodes);
    const id = `intake-exception:${primary.id}`;
    const card: IntakeExceptionCard = {
      id,
      kind: "intake_exception",
      status: "source-backed, no job - needs review",
      case_id: primary.id,
      case_ids: caseIds,
      job_id: null,
      builder: {
        id: primary.company_id || null,
        slug: company?.slug || primary.company_slug_raw || null,
        name: company?.name || null,
      },
      external_ref: primary.builder_wo_canonical ||
        primary.external_ref_canonical || primary.external_ref_raw!,
      received_at: primary.received_at,
      source_email_subject: evidence[0]?.subject || null,
      blocker_sentence: intakeBlockerSentence(neededInformation),
      needed_information: neededInformation,
      case_gaps: caseGapDetails.map((detail) => ({
        case_id: detail.row.id,
        needed_information: detail.neededInformation,
      })),
      evidence_sources: evidence,
      attachment_pointers: evidence.flatMap((source) =>
        source.attachments.map((attachment) => ({
          post_id: source.post_id,
          ...attachment,
        }))
      ),
      next_action: actions[0],
      available_actions: actions,
      human_review_required: true,
      human_approval_required: true,
      auto_create_job: false,
      auto_create_draft: false,
    };
    cards.push(card);
    for (const record of dispositions) {
      if (caseIds.includes(record.case_id)) record.card_id = id;
    }
  }
  cards.sort((a, b) =>
    a.received_at.localeCompare(b.received_at) || a.id.localeCompare(b.id)
  );

  const sourcePostIds = new Set(input.sources.map((row) => row.post_id));
  const excludedPostIds = new Set(input.excludedPostIds);
  const sourceAlarms = input.facts
    .filter((fact) =>
      fact.fate === "open_source_issue" &&
      isRecent(fact.source_received_at) &&
      !sourcePostIds.has(fact.source_instruction_id) &&
      !excludedPostIds.has(fact.source_instruction_id)
    )
    .map((fact): IntakeSourceAlarm => {
      const email = emailByPost.get(fact.source_instruction_id) || null;
      const sourceEvidence = evidenceSources(
        [{
          case_id: "",
          post_id: fact.source_instruction_id,
          role: null,
          received_at: fact.source_received_at,
          attachment_refs: [],
        }],
        emailByPost,
        attachmentsByPost,
      )[0];
      return {
        id: `intake-source-alarm:${fact.source_instruction_id}`,
        kind: "intake_source_alarm",
        source_post_id: fact.source_instruction_id,
        received_at: fact.source_received_at,
        blocker_sentence: sourceAlarmBlockerSentence(fact),
        next_action: sourceAlarmNextAction(fact),
        severity: fact.severity,
        subject: email?.subject || null,
        attachments: sourceEvidence?.attachments || [],
      };
    })
    .sort((a, b) =>
      a.received_at.localeCompare(b.received_at) || a.id.localeCompare(b.id)
    );

  const dispositionCounts = emptyDispositionCounts();
  for (const record of dispositions) {
    dispositionCounts[record.disposition]++;
  }
  const recentAccountedNonWorkRows =
    input.cases.filter((row) =>
      row.state === "accounted_non_wo" && isRecent(row.received_at)
    ).length;
  const resolvedFromExistingEvidence = dispositionCounts.bound_live_job +
    dispositionCounts.existing_job_follow_up;
  const accountedSilently = dispositionCounts.out_of_window +
    dispositionCounts.duplicate_shadow +
    dispositionCounts.correction_residue +
    dispositionCounts.deterministic_non_work +
    dispositionCounts.lineage_update +
    recentAccountedNonWorkRows;
  const outsideThree = dispositionCounts.ambiguous_for_reporting +
    sourceAlarms.length;
  return {
    contract_version: INTAKE_EXCEPTION_CARD_CONTRACT_VERSION,
    generated_at: input.generatedAt,
    org_id: input.orgId,
    recent_window: {
      days: INTAKE_EXCEPTION_RECENT_WINDOW_DAYS,
      from: windowFrom,
      to: input.generatedAt,
    },
    summary: {
      visible_actionable_cards: cards.length,
      resolved_from_existing_evidence: resolvedFromExistingEvidence,
      accounted_silently: accountedSilently,
      outside_three: outsideThree,
    },
    totals: {
      exception_case_rows: dispositions.length,
      recent_exception_case_rows: dispositions.length -
        dispositionCounts.out_of_window,
      out_of_window_exception_case_rows: dispositionCounts.out_of_window,
      recent_accounted_non_work_rows: recentAccountedNonWorkRows,
      recent_deterministic_non_work_exception_rows:
        dispositionCounts.deterministic_non_work,
      actionable_case_rows: dispositionCounts.visible_review_card,
      cards: cards.length,
      source_alarms: sourceAlarms.length,
    },
    disposition_counts: dispositionCounts,
    cards,
    source_alarms: sourceAlarms,
    dispositions: dispositions.sort((a, b) =>
      a.case_id.localeCompare(b.case_id)
    ),
  };
}

async function loadPaged(
  build: (from: number, to: number) => any,
  label: string,
): Promise<any[]> {
  const rows: any[] = [];
  for (let from = 0;; from += PAGE_SIZE) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1);
    if (error) {
      throw new Error(`${label} read failed: ${error.message || error}`);
    }
    const page = data || [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

async function loadByPostIds(
  client: any,
  table: string,
  columns: string,
  postColumn: string,
  postIds: string[],
): Promise<any[]> {
  const rows: any[] = [];
  for (let offset = 0; offset < postIds.length; offset += ID_CHUNK_SIZE) {
    const ids = postIds.slice(offset, offset + ID_CHUNK_SIZE);
    const { data, error } = await client.from(table)
      .select(columns)
      .in(postColumn, ids);
    if (error) {
      throw new Error(
        `${table} evidence read failed: ${error.message || error}`,
      );
    }
    rows.push(...(data || []));
  }
  return rows;
}

function evidencePostIdsForVisibleItems(
  generatedAt: string,
  visibleCaseIds: Set<string>,
  sources: IntakeExceptionSourceRow[],
  sourceCorrections: IntakeSourceAuthorityCorrectionRow[],
  sourceSupersessions: IntakeSourceAuthoritySupersessionRow[],
  facts: IntakeOperationalFact[],
): string[] {
  const generatedAtMs = Date.parse(generatedAt);
  const windowFromMs = generatedAtMs -
    INTAKE_EXCEPTION_RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const isRecent = (receivedAt: string | null | undefined) => {
    const receivedAtMs = Date.parse(String(receivedAt || ""));
    return Number.isFinite(receivedAtMs) &&
      receivedAtMs >= windowFromMs &&
      receivedAtMs <= generatedAtMs;
  };
  const correctionByPost = new Map(
    sourceCorrections.map((row) => [row.source_post_id, row]),
  );
  const supersessionByPost = new Map(
    sourceSupersessions.map((row) => [row.source_post_id, row]),
  );
  const postIds = new Set(
    sources.filter((source) => {
      const correction = correctionByPost.get(source.post_id);
      const supersession = supersessionByPost.get(source.post_id);
      const effectiveCaseId = supersession
        ? supersession.effective_case_id
        : correction
        ? correction.effective_case_id
        : source.case_id;
      return !!effectiveCaseId && visibleCaseIds.has(effectiveCaseId);
    }).map((row) => row.post_id),
  );
  for (const fact of facts) {
    if (
      fact.fate === "open_source_issue" &&
      isRecent(fact.source_received_at)
    ) postIds.add(fact.source_instruction_id);
  }
  return [...postIds];
}

export async function loadIntakeExceptionProjection(
  client: any,
  options: {
    orgId?: string;
    mailbox?: string;
    generatedAt?: string;
  } = {},
): Promise<IntakeExceptionProjection> {
  const orgId = options.orgId || DEFAULT_ORG_ID;
  const mailbox = options.mailbox || DEFAULT_MAILBOX;
  const generatedAt = options.generatedAt || new Date().toISOString();
  const [
    facts,
    cases,
    sources,
    sourceCorrections,
    sourceSupersessions,
    caseCorrections,
    companies,
    jobs,
    exclusions,
    refPrefixes,
  ] = await Promise.all([
    loadIntakeOperationalFacts(client, {
      orgId,
      mailbox,
      nowIso: generatedAt,
      pageSize: PAGE_SIZE,
    }),
    loadPaged(
      (from, to) =>
        client.from("makesafe_intake_cases")
          .select(
            "id,company_id,company_slug_raw,external_ref_raw,external_ref_canonical,builder_wo_canonical,builder_po_canonical,wo_po_identity_key,raw_identity_json,story_json,evidence_map,state,reason_code,missing_fields,conflicting_fields,parent_case_id,parent_relation,target_relation,job_id,target_job_id,client_name,client_phone,client_email,site_address,site_suburb,received_at",
          )
          .eq("org_id", orgId)
          .order("id", { ascending: true })
          .range(from, to),
      "intake exception cases",
    ),
    loadPaged(
      (from, to) =>
        client.from("makesafe_intake_case_sources")
          .select(
            "case_id,post_id,role,received_at,attachment_refs",
          )
          .eq("org_id", orgId)
          .order("id", { ascending: true })
          .range(from, to),
      "intake exception sources",
    ),
    loadPaged(
      (from, to) =>
        client.from("makesafe_intake_source_authority_corrections")
          .select(
            "id,source_post_id,legacy_case_id,effective_case_id,target_job_id",
          )
          .eq("org_id", orgId)
          .order("id", { ascending: true })
          .range(from, to),
      "intake source authority corrections",
    ),
    loadPaged(
      (from, to) =>
        client.from(
          "makesafe_intake_source_authority_correction_supersessions",
        )
          .select(
            "source_post_id,superseded_correction_id,prior_authority_case_id,effective_case_id",
          )
          .eq("org_id", orgId)
          .order("id", { ascending: true })
          .range(from, to),
      "intake source authority supersessions",
    ),
    loadPaged(
      (from, to) =>
        client.from("makesafe_intake_case_authority_corrections")
          .select("legacy_case_id,effective_case_id")
          .eq("org_id", orgId)
          .order("id", { ascending: true })
          .range(from, to),
      "intake case authority corrections",
    ),
    loadPaged(
      (from, to) =>
        client.from("makesafe_companies")
          .select("id,slug,name")
          .eq("org_id", orgId)
          .order("id", { ascending: true })
          .range(from, to),
      "make-safe companies",
    ),
    loadPaged(
      (from, to) =>
        client.from("makesafe_job_details")
          .select(
            "job_id,external_ref,requesting_company_slug,requesting_company_name,report_type,jobs(id,status,site_address,type,metadata)",
          )
          .order("job_id", { ascending: true })
          .range(from, to),
      "make-safe live obligations",
    ),
    loadPaged(
      (from, to) =>
        client.from("email_classifier_exclusions")
          .select("post_id")
          .eq("mailbox", mailbox)
          .order("id", { ascending: true })
          .range(from, to),
      "intake classifier exclusions",
    ),
    loadRefPrefixes(client),
  ]);

  const projectionInput: IntakeExceptionProjectionInput = {
    orgId,
    generatedAt,
    sources,
    sourceCorrections,
    sourceSupersessions,
    caseCorrections,
    companies,
    jobs,
    facts,
    cases,
    emails: [],
    attachments: [],
    excludedPostIds: exclusions.map((row) => String(row.post_id)),
    refPrefixes,
  };
  const outline = buildIntakeExceptionProjection(projectionInput);
  const postIds = evidencePostIdsForVisibleItems(
    generatedAt,
    new Set(outline.cards.flatMap((card) => card.case_ids)),
    sources,
    sourceCorrections,
    sourceSupersessions,
    facts,
  );
  const [emails, attachments] = await Promise.all([
    loadByPostIds(
      client,
      "emails",
      "post_id,subject,from_email,from_name,received_at",
      "post_id",
      postIds,
    ),
    loadByPostIds(
      client,
      "email_attachments",
      "id,email_id,name,content_type,status,size_bytes",
      "email_id",
      postIds,
    ),
  ]);

  return buildIntakeExceptionProjection({
    ...projectionInput,
    emails,
    attachments,
  });
}

export function intakeExceptionBoardPayload(
  projection: IntakeExceptionProjection,
) {
  const {
    dispositions: _dispositions,
    disposition_counts: _dispositionCounts,
    ...board
  } = projection;
  return board;
}

export function findIntakeExceptionItem(
  projection: IntakeExceptionProjection,
  selector: { cardId?: string | null; caseId?: string | null },
) {
  const card =
    projection.cards.find((candidate) =>
      (selector.cardId && candidate.id === selector.cardId) ||
      (selector.caseId && candidate.case_ids.includes(selector.caseId))
    ) || null;
  const disposition = selector.caseId
    ? projection.dispositions.find((candidate) =>
      candidate.case_id === selector.caseId
    ) || null
    : card
    ? projection.dispositions.filter((candidate) =>
      card.case_ids.includes(candidate.case_id)
    )
    : null;
  return { card, disposition };
}

export const _buildIntakeExceptionProjectionForTest =
  buildIntakeExceptionProjection;
export const _loadIntakeExceptionProjectionForTest =
  loadIntakeExceptionProjection;
