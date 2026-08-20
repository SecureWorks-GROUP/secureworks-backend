/**
 * Explicit later-attendance billing dispositions, plus the one helper-key
 * exemption for a Captain-locked second DRAFT when the live ACCREC is a
 * different-family sibling (assessment vs physical make-safe).
 *
 * `prepare_ses_invoice_obligation` still requires an identified JWT human for
 * every disposition. The helper-key door is `remint_ses_captain_lock_draft`
 * with `post_release_disposition=second_invoice` and a captain_lock override.
 * Other enums stay JWT-only and are refused on remint.
 */
import {
  canonicalSesFamilyFromCard,
  type SesFamilyId,
} from "./ses_family_matrix.ts";

export const SES_POST_RELEASE_DISPOSITIONS = [
  "second_invoice",
  "combine_credit",
  "document_only",
  "hold_pricing",
] as const;

export type SesPostReleaseDisposition =
  (typeof SES_POST_RELEASE_DISPOSITIONS)[number];

const DISPOSITION_SET = new Set<string>(SES_POST_RELEASE_DISPOSITIONS);

/**
 * Accept the sealed enum or the operator's spaced form ("second invoice").
 * Unknown text returns null; the caller refuses rather than guessing.
 */
export function normalizePostReleaseDisposition(
  raw: unknown,
): SesPostReleaseDisposition | null {
  if (raw == null) return null;
  const token = String(raw).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!token) return null;
  return DISPOSITION_SET.has(token) ? token as SesPostReleaseDisposition : null;
}

/**
 * Family used only to decide whether a live ACCREC on another card is this
 * card's own work. Metadata family wins; `report_type` is the assessment/roof
 * fallback when `makesafe_job_family` is blank (the live Myalup pair).
 * Unresolved stays `unknown` so the caller fails closed.
 */
export function sesInvoiceFamilyFromCardFacts(args: {
  makesafe_job_family?: unknown;
  ses_family?: unknown;
  insurance_job_type?: unknown;
  own_template_requested?: unknown;
  strata?: unknown;
  report_delivery?: unknown;
  report_type?: unknown;
}): SesFamilyId {
  const fromFamily = canonicalSesFamilyFromCard({
    makesafe_job_family: args.makesafe_job_family ?? args.ses_family,
    insurance_job_type: args.insurance_job_type,
    own_template_requested: args.own_template_requested,
    strata: args.strata,
    report_delivery: args.report_delivery,
  });
  if (fromFamily !== "unknown") return fromFamily;
  return canonicalSesFamilyFromCard({
    makesafe_job_family: args.report_type,
    insurance_job_type: args.insurance_job_type,
    own_template_requested: args.own_template_requested,
    strata: args.strata,
    report_delivery: args.report_delivery,
  });
}

/**
 * A live invoice may be skipped for an explicit Captain-locked second DRAFT
 * only when it is attributed to a different card AND a different resolved
 * family. Same card, missing attribution, or unknown/same family stay blocking.
 */
export function siblingLiveInvoiceMayYieldToSecondInvoice(args: {
  ourJobId: string;
  invoiceJobId: string | null | undefined;
  ourFamily: SesFamilyId | string;
  invoiceFamily: SesFamilyId | string;
}): boolean {
  const ours = String(args.ourJobId || "").trim();
  const theirs = String(args.invoiceJobId || "").trim();
  if (!ours || !theirs || ours === theirs) return false;
  const ourFamily = String(args.ourFamily || "unknown");
  const invoiceFamily = String(args.invoiceFamily || "unknown");
  if (
    !ourFamily || !invoiceFamily || ourFamily === "unknown" ||
    invoiceFamily === "unknown"
  ) {
    return false;
  }
  return ourFamily !== invoiceFamily;
}
