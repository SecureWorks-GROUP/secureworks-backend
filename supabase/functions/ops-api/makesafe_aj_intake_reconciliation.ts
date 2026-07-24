import {
  normaliseJobFamily,
  normaliseRef,
  subjectJobNumber,
} from "./makesafe_intake_dedup.ts";
import { canonicalCompanyDedupeKey } from "../_shared/makesafe_refs.ts";

export interface AjIntakePrefill {
  external_ref: string;
  client_name: string;
  client_phone: string | null;
  site_address: string;
  site_suburb: string | null;
  builder_claim_ref: string;
  builder_work_order_number: string;
  deterministic_source: "aj_labelled_email";
}

export interface AjIntakePrefillInput {
  fromEmail?: string | null;
  subject?: string | null;
  bodyText?: string | null;
}

export interface ExistingJobBindingCorrection {
  org_id?: string | null;
  source_post_id?: string | null;
  target_job_id?: string | null;
  correction_kind?: string | null;
  expected_identity_key?: string | null;
}

export interface ExistingJobBindingDraft {
  org_id?: string | null;
  graph_message_id?: string | null;
}

export interface ExistingJobBindingApprovedFields {
  requesting_company_slug?: string | null;
  requesting_company_name?: string | null;
  external_ref?: string | null;
  client_name?: string | null;
  site_address?: string | null;
}

export interface ExistingJobBindingTargetJob {
  id?: string | null;
  job_number?: string | null;
  status?: string | null;
  type?: string | null;
  client_name?: string | null;
  site_address?: string | null;
  metadata?: Record<string, unknown> | string | null;
}

export interface ExistingJobBindingTargetDetails {
  job_id?: string | null;
  external_ref?: string | null;
  requesting_company_slug?: string | null;
  requesting_company_name?: string | null;
}

const AJ_SENDER_DOMAIN = "ajs.build";
const DEAD_JOB_STATUSES = new Set([
  "cancelled",
  "canceled",
  "void",
  "voided",
  "superseded",
]);

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function labelledLine(body: string, labels: string): string | null {
  const linePattern = new RegExp(
    `^[ \\t]*(?:${labels})[ \\t]*:[ \\t]*(.*)$`,
    "i",
  );
  for (const line of body.split(/\r?\n/)) {
    const value = clean(linePattern.exec(line)?.[1]);
    if (value) return value;
  }
  return null;
}

function addressSuburb(address: string): string | null {
  const commaTail = /,\s*([A-Za-z][A-Za-z' -]*?)\s+(?:WA|W\.A\.)\s+\d{4}\s*$/i
    .exec(address);
  if (commaTail) return clean(commaTail[1]) || null;
  return null;
}

function senderDomain(fromEmail: string): string {
  const at = fromEmail.lastIndexOf("@");
  return at >= 0 ? fromEmail.slice(at + 1).trim().toLowerCase() : "";
}

/**
 * Cheap deterministic prefill for the exact AJS dispatch template. It is
 * intentionally narrow: direct ajs.build sender, direct "Make Safe" subject,
 * a labelled bare Job No, and unambiguous labelled body fields. It never raises
 * confidence or removes the extraction-degraded marker, so a provider outage
 * remains review-only.
 */
export function deriveAjIntakePrefill(
  input: AjIntakePrefillInput,
): AjIntakePrefill | null {
  const fromEmail = clean(input.fromEmail).toLowerCase();
  const subject = clean(input.subject);
  const body = String(input.bodyText ?? "");
  if (senderDomain(fromEmail) !== AJ_SENDER_DOMAIN) return null;
  if (!/^make\s*safe\b/i.test(subject) || /^(?:re|fw|fwd)\s*:/i.test(subject)) {
    return null;
  }

  const jobNumber = subjectJobNumber(subject);
  if (!jobNumber) return null;
  const address = labelledLine(body, "address");
  const clientName = labelledLine(body, "contact|client|insured");
  if (!address || !clientName) return null;

  const canonicalRef = `AJBR-${jobNumber}`;
  return {
    external_ref: jobNumber,
    client_name: clientName,
    client_phone: labelledLine(body, "mobile|phone"),
    site_address: address,
    site_suburb: addressSuburb(address),
    builder_claim_ref: canonicalRef,
    builder_work_order_number: canonicalRef,
    deterministic_source: "aj_labelled_email",
  };
}

export function applyAjIntakePrefill(
  extraction: Record<string, unknown>,
  prefill: AjIntakePrefill | null,
): { extraction: Record<string, unknown>; filledFields: string[] } {
  if (!prefill) return { extraction: { ...extraction }, filledFields: [] };
  const next = { ...extraction };
  const filledFields: string[] = [];
  for (
    const key of [
      "external_ref",
      "client_name",
      "client_phone",
      "site_address",
      "site_suburb",
      "builder_claim_ref",
      "builder_work_order_number",
    ] as const
  ) {
    if (!clean(next[key]) && clean(prefill[key])) {
      next[key] = prefill[key];
      filledFields.push(key);
    }
  }
  if (filledFields.length) {
    next.deterministic_prefill_source = prefill.deterministic_source;
    next.deterministic_prefill_fields = filledFields;
  }
  return { extraction: next, filledFields };
}

function parseObject(
  value: Record<string, unknown> | string | null | undefined,
): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch (_) {
    return {};
  }
}

function addressKey(value: unknown): string {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function nameKey(value: unknown): string {
  return clean(value).toLowerCase().replace(/\s+/g, " ");
}

function refMatchesAjJobNumber(value: unknown, jobNumber: string): boolean {
  const actual = normaliseRef(clean(value));
  return new Set([
    jobNumber,
    `AJBR${jobNumber}`,
    `AJS${jobNumber}`,
  ]).has(actual);
}

function fail(reason: string): never {
  throw new Error(
    `existing_job_binding_reconciliation_required: ${reason}`,
  );
}

/**
 * Inverse binding guard for the review gate. A correction may link a draft to an
 * existing job only when the source itself proves the same AJ identity and the
 * chosen review fields agree with one non-cancelled MakeSafe target. A stale
 * correction aimed at a cancelled duplicate therefore fails closed.
 */
export function assertAjExistingJobBinding(input: {
  correction: ExistingJobBindingCorrection;
  draft: ExistingJobBindingDraft;
  prefill: AjIntakePrefill | null;
  approvedFields: ExistingJobBindingApprovedFields;
  approvedJobFamily?: string | null;
  targetJob: ExistingJobBindingTargetJob;
  targetDetails: ExistingJobBindingTargetDetails;
}): void {
  const {
    correction,
    draft,
    prefill,
    approvedFields,
    targetJob,
    targetDetails,
  } = input;
  if (correction.correction_kind !== "existing_job_binding") {
    fail("correction kind is not existing_job_binding");
  }
  if (
    !clean(draft.org_id) ||
    clean(correction.org_id) !== clean(draft.org_id) ||
    clean(correction.source_post_id) !== clean(draft.graph_message_id)
  ) {
    fail("correction does not bind this exact org/source");
  }
  if (!prefill) {
    fail("source does not prove the guarded AJ labelled-email shape");
  }
  if (
    clean(correction.expected_identity_key) !==
      `wo:${prefill.builder_work_order_number}`
  ) {
    fail("correction identity does not match the source-derived work order");
  }
  if (
    !clean(targetJob.id) ||
    clean(correction.target_job_id) !== clean(targetJob.id) ||
    clean(targetDetails.job_id) !== clean(targetJob.id)
  ) {
    fail("correction target and loaded job disagree");
  }
  if (clean(targetJob.type).toLowerCase() !== "makesafe") {
    fail("target is not a MakeSafe job");
  }
  if (DEAD_JOB_STATUSES.has(clean(targetJob.status).toLowerCase())) {
    fail("target job is cancelled, void or superseded");
  }

  const jobNumber = prefill.external_ref;
  const metadata = parseObject(targetJob.metadata);
  if (
    !refMatchesAjJobNumber(targetDetails.external_ref, jobNumber) ||
    !refMatchesAjJobNumber(metadata.external_ref, jobNumber) ||
    !refMatchesAjJobNumber(approvedFields.external_ref, jobNumber)
  ) {
    fail("source, reviewed fields and target external reference disagree");
  }
  if (
    addressKey(prefill.site_address) !== addressKey(targetJob.site_address) ||
    addressKey(prefill.site_address) !== addressKey(approvedFields.site_address)
  ) {
    fail("source, reviewed fields and target address disagree");
  }
  if (
    nameKey(prefill.client_name) !== nameKey(targetJob.client_name) ||
    nameKey(prefill.client_name) !== nameKey(approvedFields.client_name)
  ) {
    fail("source, reviewed fields and target client disagree");
  }

  const approvedCompany = canonicalCompanyDedupeKey(
    approvedFields.requesting_company_slug ||
      approvedFields.requesting_company_name ||
      null,
  );
  const targetCompany = canonicalCompanyDedupeKey(
    targetDetails.requesting_company_slug ||
      targetDetails.requesting_company_name ||
      null,
  );
  if (!approvedCompany || !targetCompany || approvedCompany !== targetCompany) {
    fail("reviewed and target requesting company disagree");
  }

  const metadataFamily = normaliseJobFamily(
    clean(metadata.makesafe_job_family),
  );
  const approvedFamily = normaliseJobFamily(input.approvedJobFamily);
  if (metadataFamily && approvedFamily && metadataFamily !== approvedFamily) {
    fail("reviewed and target MakeSafe family disagree");
  }
}
