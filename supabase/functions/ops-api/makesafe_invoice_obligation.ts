import {
  type SesSha256,
  sesSha256,
  stableUuidFromSha256,
} from "./ses_docket_envelope.ts";
import type { SesInvoiceDuplicateResolution } from "./makesafe_invoice_duplicate_resolver.ts";
import { type SesRefusal, sesRefusal } from "./ses_reporting_refusals.ts";

export type SesPricingDisposition =
  | "priced_from_canon"
  | "priced_with_line_override"
  | "no_additional_charge"
  | "money_review_required"
  | "blocked_missing_evidence"
  | "blocked_company_ambiguous"
  | "blocked_parked_rule"
  | "blocked_billing_disposition"
  | "blocked_duplicate_live";

// Exact SHA-256 of the dated Captain pricing canon consumed by the sealed U4
// assembler and stamped into every U5 proposal. Callers cannot choose this.
export const SES_PRICING_CANON_VERSION =
  "pricing-and-invoice-rules@sha256:7a116693ed57ab19a0076238fd860f572bb054868465e27415e7f85e983fe42b";

export interface SesInvoiceProposalLine {
  description: string;
  quantity: number;
  unit_price: number;
  account_code: string;
  evidence: Record<string, unknown>;
  rate_override_approved?: boolean;
  rate_override_by?: string;
  rate_override_at?: string;
}

export interface SesInvoiceProposalV1 {
  schema: "secureworks.makesafe.invoice-proposal/v1";
  invoice_obligation_id: string;
  invoice_obligation_revision_id: string;
  job_id: string;
  attendance_cycle_ids: string[];
  pricing_disposition: SesPricingDisposition;
  pricing_canon_version: string;
  company: string;
  reference: string;
  contact_name: string;
  currency: "AUD";
  lines: SesInvoiceProposalLine[];
  totals: { ex: number; inc: number };
  guard_result: {
    hard_failures: string[];
    warnings: string[];
  };
  duplicate_probe: {
    allows_create: boolean;
    match_tier: string | null;
    ambiguity: string;
  };
  xero: null;
}

export interface SesPrepareInvoiceObligationInput {
  org_id: string;
  job_id: string;
  docket_revision_id: string;
  attendance_cycle_ids: string[];
  pricing_disposition: SesPricingDisposition;
  pricing_canon_version: string;
  company: string;
  reference: string;
  contact_name: string;
  lines: SesInvoiceProposalLine[];
  guard_result: {
    hard_failures: string[];
    warnings: string[];
  };
  duplicate_probe: SesInvoiceDuplicateResolution;
  created_by: string;
  existing?: {
    obligation_id: string;
    revision_id: string;
    state: string;
    released_cycle_ids?: string[];
  } | null;
  post_release_disposition?:
    | "second_invoice"
    | "combine_credit"
    | "document_only"
    | "hold_pricing"
    | null;
  allocate_uuid?: () => string;
}

export interface SesPreparedInvoiceObligation {
  state: "prepared" | "blocked";
  obligation: Record<string, unknown>;
  revision: Record<string, unknown>;
  proposal: SesInvoiceProposalV1;
  blockers: SesRefusal[];
}

const EXECUTABLE_DISPOSITIONS = new Set<SesPricingDisposition>([
  "priced_from_canon",
  "priced_with_line_override",
  "no_additional_charge",
]);

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .sort();
}

function validateLines(
  disposition: SesPricingDisposition,
  lines: SesInvoiceProposalLine[],
): SesRefusal[] {
  if (disposition === "no_additional_charge") return [];
  if (!EXECUTABLE_DISPOSITIONS.has(disposition) || lines.length === 0) {
    return [
      sesRefusal(
        "pricing_evidence_missing",
        "Record the evidenced hours, materials, storeys, and approved rate before approving the invoice.",
      ),
    ];
  }
  const invalid = lines.find((line) =>
    !line.description.trim() ||
    !Number.isFinite(line.quantity) ||
    line.quantity <= 0 ||
    !Number.isFinite(line.unit_price) ||
    line.unit_price < 0 ||
    !line.account_code.trim() ||
    Object.keys(line.evidence || {}).length === 0
  );
  if (invalid) {
    return [
      sesRefusal(
        "pricing_evidence_missing",
        "Correct the invoice line and attach the real trade or work-order evidence that proves it.",
        { evidence: { line_description: invalid.description || null } },
      ),
    ];
  }
  if (
    disposition === "priced_with_line_override" &&
    lines.some((line) =>
      !line.rate_override_approved || !line.rate_override_by ||
      !line.rate_override_at
    )
  ) {
    return [
      sesRefusal(
        "pricing_evidence_missing",
        "Record who approved each rate override and when before approving the invoice.",
        {
          fact:
            "A price line uses a rate override without the required human approval audit.",
        },
      ),
    ];
  }
  return [];
}

export async function prepareSesInvoiceObligation(
  input: SesPrepareInvoiceObligationInput,
): Promise<SesPreparedInvoiceObligation> {
  const cycles = sortedUnique(input.attendance_cycle_ids);
  if (cycles.length === 0) {
    throw new TypeError("at least one attendance_cycle_id is required");
  }

  const priorReleased = input.existing &&
    ["create_executed", "authorised", "released"].includes(
      input.existing.state,
    );
  const blockers: SesRefusal[] = [];
  if (priorReleased && !input.post_release_disposition) {
    blockers.push(
      sesRefusal(
        "post_release_disposition_missing",
        "Choose second invoice, combine/credit review, document only, or hold pricing for the later attendance.",
        { decision_key: "post-release-reattend-disposition" },
      ),
    );
  }
  if (
    input.pricing_disposition !== "no_additional_charge" &&
    !input.duplicate_probe.allows_create
  ) {
    // `sibling_po` joins `multi_live` on the AMBIGUOUS refusal rather than the plain duplicate one:
    // the card has no bound invoice to point at, it has a claim sibling whose purchase-order
    // evidence cannot say which invoice covers this work. "Resolve which invoice owns this" is the
    // action an operator can actually take; "use the bound live invoice" names one that may not exist.
    const ambiguous = ["multi_live", "sibling_po"].includes(
      input.duplicate_probe.ambiguity,
    );
    blockers.push(
      sesRefusal(
        ambiguous ? "invoice_duplicate_ambiguous" : "invoice_duplicate_live",
        ambiguous
          ? "Resolve which live Xero invoice owns this work before creating any invoice."
          : "Use the bound live invoice or record an explicit post-release compensation disposition.",
        { evidence: { duplicate_probe: input.duplicate_probe } },
      ),
    );
  }
  blockers.push(...validateLines(input.pricing_disposition, input.lines));

  const mustMintNew = !input.existing || priorReleased;
  // `crypto.randomUUID` is a native method that needs its Crypto receiver. Extracting it with
  // `(input.allocate_uuid || crypto.randomUUID)()` detaches it and throws "Illegal invocation" in
  // Deno, so the production branch could never mint an obligation id. Every test injects
  // `allocate_uuid`, which is why the suite never exercised it.
  const obligationId = mustMintNew
    ? (input.allocate_uuid ? input.allocate_uuid() : crypto.randomUUID())
    : input.existing!.obligation_id;
  const lineSet = input.lines.map((line) => ({
    ...line,
    description: line.description.trim(),
    account_code: line.account_code.trim(),
  }));
  const content = {
    obligation_id: obligationId,
    attendance_cycle_ids: cycles,
    pricing_disposition: input.pricing_disposition,
    lines: lineSet,
    contact_name: input.contact_name.trim(),
    reference: input.reference.trim(),
    currency: "AUD",
    account_codes: sortedUnique(lineSet.map((line) => line.account_code)),
    builder_schedule_version: input.pricing_canon_version,
  };
  const contentHash = await sesSha256(
    content,
    "SecureWorks:ses-invoice-obligation-revision:v1\n",
  );
  const revisionId = stableUuidFromSha256(contentHash);
  const cycleSetHash = await sesSha256(
    cycles,
    "SecureWorks:ses-attendance-cycle-set:v1\n",
  );
  const ex = Math.round(
    lineSet.reduce(
      (total, line) => total + line.quantity * line.unit_price,
      0,
    ) * 100,
  ) / 100;
  const proposal: SesInvoiceProposalV1 = {
    schema: "secureworks.makesafe.invoice-proposal/v1",
    invoice_obligation_id: obligationId,
    invoice_obligation_revision_id: revisionId,
    job_id: input.job_id,
    attendance_cycle_ids: cycles,
    pricing_disposition: input.pricing_disposition,
    pricing_canon_version: input.pricing_canon_version,
    company: input.company,
    reference: input.reference.trim(),
    contact_name: input.contact_name.trim(),
    currency: "AUD",
    lines: lineSet,
    totals: { ex, inc: Math.round(ex * 1.1 * 100) / 100 },
    guard_result: input.guard_result,
    duplicate_probe: {
      allows_create: input.duplicate_probe.allows_create,
      match_tier: input.duplicate_probe.match_tier,
      ambiguity: input.duplicate_probe.ambiguity,
    },
    xero: null,
  };
  const state = blockers.length > 0 ||
      !EXECUTABLE_DISPOSITIONS.has(input.pricing_disposition)
    ? "blocked"
    : "proposed";
  return {
    state: state === "blocked" ? "blocked" : "prepared",
    obligation: {
      id: obligationId,
      org_id: input.org_id,
      job_id: input.job_id,
      status: "open",
      mint_reason: mustMintNew
        ? (priorReleased
          ? "post_release_human_disposition"
          : "first_u4_commercial_proposal")
        : "reuse_open_pre_release_obligation",
      minted_by: input.created_by,
      supersedes_obligation_id: priorReleased && input.existing
        ? input.existing.obligation_id
        : null,
      post_release_disposition: input.post_release_disposition || null,
    },
    revision: {
      id: revisionId,
      org_id: input.org_id,
      job_id: input.job_id,
      obligation_id: obligationId,
      content_hash: contentHash satisfies SesSha256,
      attendance_cycle_ids: cycles,
      attendance_cycle_set_hash: cycleSetHash,
      pricing_disposition: input.pricing_disposition,
      proposal,
      duplicate_probe: proposal.duplicate_probe,
      blockers,
      supersedes_revision_id: !mustMintNew && input.existing
        ? input.existing.revision_id
        : null,
      state,
      created_by: input.created_by,
      docket_revision_id: input.docket_revision_id,
    },
    proposal,
    blockers,
  };
}
