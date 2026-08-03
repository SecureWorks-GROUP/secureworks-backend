export interface SesRefusal {
  state: "refused";
  code: string;
  fact: string;
  recovery_action: string;
  decision_key?: string;
  evidence?: Record<string, unknown>;
}

const FACTS = {
  no_trade_report_submitted:
    "No trade report was submitted for the current attendance.",
  portal_link_dead:
    "The builder portal link could not be opened, so the portal report is not proven complete.",
  roof_report_not_filled:
    "The SecureWorks roof report has not been filled out.",
  assessment_recipe_parked:
    "The assessment outbound recipe is still awaiting the Captain's decision.",
  report_only_email_applicability_parked:
    "Whether report-only work uses the universal three-email release is still awaiting the Captain's decision.",
  invoice_duplicate_live:
    "A live non-void Xero invoice already covers this released work.",
  invoice_duplicate_ambiguous:
    "More than one live Xero invoice matches this work, so the billed identity is ambiguous.",
  invoice_effect_already_reserved:
    "This invoice revision already has an invoice-create operation; a second invoice create is refused.",
  release_route_already_reserved:
    "This exact release route already has a send operation; a second send is refused.",
  stale_review:
    "New evidence landed after this review, so the displayed approval is stale.",
  curated_source_missing:
    "The completion report lacks an independently byte-bound current-cycle curated source, so it is hidden from the trusted pack.",
  xero_not_authorised:
    "The current Xero invoice is not AUTHORISED, so its real invoice PDF cannot be released.",
  route_draft_missing:
    "A required builder email draft is missing from the current docket revision.",
  route_recipient_invalid:
    "A release email route contains text that is not an email recipient.",
  canonical_recipient_missing:
    "A required email route has no canonical builder mailbox recipient.",
  pricing_evidence_missing:
    "The current evidence does not prove the invoice price.",
  post_release_disposition_missing:
    "Released work has a later attendance, but no human billing disposition has been recorded.",
  release_approval_missing:
    "No current human SEND IT approval exists for this exact release revision.",
  docs_ready_signoff_missing:
    "No current Captain Docs Ready signoff exists for the exact docket bytes.",
  invoice_approval_missing:
    "No current human APPROVE INVOICE decision exists for this exact invoice revision.",
  graph_outcome_unknown:
    "Microsoft Graph accepted or may have accepted the message, but its exact sent outcome is not yet proven.",
  xero_outcome_unknown:
    "Xero accepted or may have accepted the invoice operation, but its exact outcome is not yet proven.",
  ses_invoice_void_status_forbidden:
    "The invoice status cannot be changed through the SES-native void workflow.",
  ses_invoice_void_requires_accrec:
    "The SES-native void workflow applies only to sales invoices.",
  ses_invoice_void_requires_sealed_job:
    "The invoice is not bound to an authoritatively sealed SES job.",
} as const;

export type SesRefusalCode = keyof typeof FACTS;

export function sesRefusal(
  code: SesRefusalCode,
  recovery_action: string,
  options: {
    decision_key?: string;
    evidence?: Record<string, unknown>;
    fact?: string;
  } = {},
): SesRefusal {
  return {
    state: "refused",
    code,
    fact: options.fact || FACTS[code],
    recovery_action,
    ...(options.decision_key ? { decision_key: options.decision_key } : {}),
    ...(options.evidence ? { evidence: options.evidence } : {}),
  };
}

export function isSesRefusal(value: unknown): value is SesRefusal {
  return !!value && typeof value === "object" &&
    (value as SesRefusal).state === "refused" &&
    typeof (value as SesRefusal).fact === "string" &&
    (value as SesRefusal).fact.trim().length > 0;
}
