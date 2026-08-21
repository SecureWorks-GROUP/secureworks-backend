/**
 * Explicit later-attendance billing dispositions, plus the exemption for a
 * second DRAFT when the live ACCREC is a different-family sibling
 * (assessment vs physical make-safe; Lake Preston / Myalup).
 *
 * `prepare_ses_invoice_obligation` still requires an identified JWT human for
 * every disposition. JWT + `second_invoice` is the cockpit mint path: prepare
 * then `create_ses_invoice_draft` may mint a new DRAFT on the MS card. The
 * helper-key door is `remint_ses_captain_lock_draft` with the same disposition
 * and a captain_lock override. Other enums stay JWT-only and are refused on
 * remint. api_key still cannot attach a disposition on prepare.
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

/**
 * True only when EVERY live ACCREC is a different-job different-family sibling
 * of this card. Empty list fails closed. One same-card, unattributed, unknown-
 * family, or same-family row fails the whole set (Lake Preston: assessment
 * INV-0876 and roof INV-0877 may both match the claim; both must yield).
 */
export async function siblingLiveInvoicesAllYieldToSecondInvoice(args: {
  ourJobId: string;
  loadCardFamily: (jobId: string) => Promise<string>;
  liveInvoices: Array<{ job_id?: string | null }>;
}): Promise<
  | {
    yields: true;
    ourFamily: string;
    siblings: Array<{ job_id: string; family: string }>;
  }
  | { yields: false }
> {
  if (!Array.isArray(args.liveInvoices) || args.liveInvoices.length === 0) {
    return { yields: false };
  }
  const ourFamily = await args.loadCardFamily(args.ourJobId);
  const siblings: Array<{ job_id: string; family: string }> = [];
  for (const invoice of args.liveInvoices) {
    const invoiceJobId = String(invoice.job_id || "").trim();
    const invoiceFamily = invoiceJobId
      ? await args.loadCardFamily(invoiceJobId)
      : "unknown";
    if (
      !siblingLiveInvoiceMayYieldToSecondInvoice({
        ourJobId: args.ourJobId,
        invoiceJobId,
        ourFamily,
        invoiceFamily,
      })
    ) {
      return { yields: false };
    }
    siblings.push({ job_id: invoiceJobId, family: invoiceFamily });
  }
  return { yields: true, ourFamily, siblings };
}

export function matchingInvoiceRowForHit(
  hit: { xero_invoice_id?: string | null; invoice_number?: string | null } | null | undefined,
  liveInvoices: Array<Record<string, unknown>>,
): Record<string, unknown> | null {
  if (!hit || !Array.isArray(liveInvoices) || liveInvoices.length === 0) {
    return null;
  }
  const xeroId = String(hit.xero_invoice_id || "").trim();
  const invoiceNumber = String(hit.invoice_number || "").trim();
  return liveInvoices.find((row) => {
    const rowXero = String(row.xero_invoice_id || "").trim();
    const rowNumber = String(row.invoice_number || "").trim();
    return (xeroId && rowXero === xeroId) ||
      (invoiceNumber && rowNumber === invoiceNumber);
  }) ?? null;
}

export type SesInvoiceFamilyClient = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => {
        maybeSingle: () => Promise<{
          data: unknown;
          error: { message?: string } | null;
        }>;
      };
    };
  };
};

/**
 * Family reader shared by JWT prepare/create and captain-lock remint.
 * PostgREST errors throw; a missing row is `unknown` so callers fail closed.
 */
export async function loadSesInvoiceCardFamily(
  client: SesInvoiceFamilyClient,
  jobId: string,
): Promise<SesFamilyId> {
  const job = await client.from("jobs")
    .select("id,metadata")
    .eq("id", jobId)
    .maybeSingle();
  if (job.error) {
    throw new Error(`The job family could not be read (${job.error.message}).`);
  }
  const detail = await client.from("makesafe_job_details")
    .select("report_type,report_delivery")
    .eq("job_id", jobId)
    .maybeSingle();
  if (detail.error) {
    throw new Error(
      `The make-safe family could not be read (${detail.error.message}).`,
    );
  }
  const jobRow = job.data && typeof job.data === "object"
    ? job.data as { metadata?: unknown }
    : null;
  const metadata = jobRow?.metadata && typeof jobRow.metadata === "object"
    ? jobRow.metadata as Record<string, unknown>
    : {};
  const detailRow = detail.data && typeof detail.data === "object"
    ? detail.data as { report_type?: unknown; report_delivery?: unknown }
    : null;
  return sesInvoiceFamilyFromCardFacts({
    makesafe_job_family: metadata.makesafe_job_family,
    ses_family: metadata.ses_family,
    insurance_job_type: metadata.insurance_job_type,
    own_template_requested: metadata.own_template_requested,
    strata: metadata.strata,
    report_delivery: metadata.report_delivery || detailRow?.report_delivery,
    report_type: detailRow?.report_type,
  });
}
