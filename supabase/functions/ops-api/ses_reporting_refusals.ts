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
  // `report_only_email_applicability_parked` was retired on 2026-08-06 when the
  // Captain ruled the question (`data/decisions/2026-08-06-roof-report-email-shape.md`):
  // a roof-report card sends ONE email, to the group inbox, carrying the
  // invoice. Its fact said the decision was "still awaiting the Captain" and
  // keeping that sentence in the catalogue would have been false text for a
  // question that is answered. Nothing emits the code; see the retirement note
  // in ses_review_cockpit.ts for where the ruling now lives.
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
  authorised_derivative_mismatch:
    "The AUTHORISED Xero invoice or PDF differs from the exact approved DRAFT outside the permitted status and invoice-number changes.",
  route_draft_missing:
    "A required builder email draft is missing from the current docket revision.",
  intake_thread_reply_unavailable:
    "The MLB physical report or photo route must reply on the work-order intake thread, but no intake_thread_id is available.",
  route_recipient_invalid:
    "A release email route contains text that is not an email recipient.",
  route_body_internal_annotation:
    "A persisted release route body still carries internal draft-annotation wording, which must never reach a builder inbox.",
  canonical_recipient_missing:
    "A required email route has no canonical builder mailbox recipient.",
  pricing_evidence_missing:
    "The current evidence does not prove the invoice price.",
  docket_pricing_stale:
    "The docket was priced under a superseded family matrix, so minting from it could reissue superseded rates.",
  invoice_retry_not_permitted:
    "A deliberate mint retry is only permitted when every prior attempt is provably stranded (unknown/failed, no Xero checkpoint, nothing reconcilable).",
  invoice_exists_unbound:
    "Xero already carries live money for this card that the current docket does not bind, so minting here would bill already-billed work.",
  post_release_disposition_missing:
    "Released work has a later attendance, but no human billing disposition has been recorded.",
  release_approval_missing:
    "No current human SEND IT approval exists for this exact release revision.",
  release_in_flight:
    "An older release containing this exact docket has started dispatch and must be reconciled before corrected content can be minted.",
  docs_ready_signoff_missing:
    "No current Captain Docs Ready signoff exists for the exact docket bytes.",
  invoice_approval_missing:
    "No current human APPROVE INVOICE decision exists for this exact invoice revision.",
  invoice_approval_unreadable:
    "The invoice approval and Xero binding records could not be read, so the invoice decision cannot be proven either way.",
  route_send_proof_unreadable:
    "The release send effect ledger could not be read, so whether this release has already dispatched a route to the builder cannot be proven either way.",
  external_effect_payload_drift:
    "The caller payload differs from the immutable payload already reserved for this exact external-effect operation.",
  graph_outcome_unknown:
    "Microsoft Graph accepted or may have accepted the message, but its exact sent outcome is not yet proven.",
  xero_outcome_unknown:
    "Xero accepted or may have accepted the invoice operation, but its exact outcome is not yet proven.",
  invoice_mirror_unreadable:
    "The bound Xero invoice's local mirror could not be read, so the confirmed mint's SES token linkage cannot be proven and must not be rewritten.",
  bound_invoice_not_live:
    "The obligation's bound Xero invoice is VOIDED or DELETED, so it cannot be adopted for send or authorise.",
  ses_invoice_void_status_forbidden:
    "The invoice status cannot be changed through the SES-native void workflow.",
  ses_invoice_void_requires_accrec:
    "The SES-native void workflow applies only to sales invoices.",
  ses_invoice_void_requires_binding:
    "The invoice has no explicit SES obligation or external-effect binding.",
  photo_mail_volume_exceeds_graph_limit:
    "The photo pack exceeds the documented Microsoft Graph / Exchange mail size ceiling for a single message, so the builder photo email is refused before any Graph call. Photos are never culled or downscaled to fit.",
  unsupported_family_variant:
    "The selected builder and SES family do not resolve to an executable typed workflow variant.",
  deliverable_not_active:
    "The repair or restoration card has no active SES reporting deliverable.",
  family_contract_incomplete:
    "The exact SES workflow profile chain is incomplete.",
  family_contract_divergent:
    "The exact SES workflow profile chain does not share the current canonical contract hash.",
  family_contract_invalid:
    "The typed SES workflow contract failed internal validation.",
  family_contract_unsealed:
    "The selected SES workflow variant is known but not sealed for this operation.",
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
