// Builder-scoped SES release route shapes.
//
// Captain ruling 2026-08-04 (AJS/AJBR only):
//   two emails — (A) report + invoice together, (B) photos follow-up;
//   TO workorders@ajs.build + thread participants; from admin@.
//
// Captain ruling 2026-08-06 (AJS/AJBR permanent builder CCs):
//   CC on ALL AJS/AJBR pack emails: ses@ + vanessa@ajs.build + mandi@ajs.build.
//   Domain spelling is always ajs.build (never ajsbuild / ajsbuid).
//
// Captain ruling 2026-08-05 (MLB physical / Maylands):
//   three emails, two destinations — still route_kind order report/photo/invoice:
//   1. report  — report-only (locked: intake-thread reply; TEMP exception: ordinary Mail.Send)
//   2. photo   — photos-only (same transport as report)
//   3. invoice — billing pack to makesafes@ (report + AUTHORISED invoice + SWMS)
//   Exception flag: MLB_PHYSICAL_ORDINARY_MAIL_SEND_FALLBACK_V1 in ses_mlb_thread_reply.ts
//   AJS shape is untouched (CC list is AJS-only; do not widen to MLB).
//
// Captain ruling 2026-08-06 (MLB physical destinations — the two-destination
// half of the 2026-08-05 shape, which had never actually resolved):
//   1. TO makesafes@mlbuilders.com.au — invoice + SWMS + report TOGETHER
//   2. TO mlb.mailer@primeeco.tech    — the report, on the work-order subject
//   3. TO mlb.mailer@primeeco.tech    — all the photos
//   No invoice on either Prime mailer route. Producer: mlbPhysicalRouteRecipients().

import type { SesFamilyMatrixRow } from "./ses_family_matrix.ts";
import {
  AJS_MANDI_CC,
  AJS_VANESSA_CC,
  AJS_WORK_ORDERS_MAILBOX,
  MLB_PRIME_MAILER,
  SES_RELEASE_CC,
} from "./ses_graph_mail_gateway.ts";
import {
  applyMlbThreadReplyToRoute,
  isMlbBuilderKey,
  isMlbPhysicalReleaseShape,
  mlbPhysicalUsesOrdinaryMailSendFallback,
  routingIntakeThread,
} from "./ses_mlb_thread_reply.ts";

export {
  AJS_MANDI_CC,
  AJS_VANESSA_CC,
  AJS_WORK_ORDERS_MAILBOX,
  isMlbBuilderKey,
  MLB_PRIME_MAILER,
  SES_RELEASE_CC,
};

export type SesReleaseBuilderKey = "AJS" | "AJBR" | "MLB" | "WESTERN" | string;
export type SesRouteKind = "report" | "photo" | "invoice" | "report_invoice";

export const SES_WORKFLOW_SEND_RULE_VERSION = "ses-workflow-send/2026-08-15.3";

export const SES_UNIVERSAL_ROUTE_ORDER: SesRouteKind[] = [
  "report",
  "photo",
  "invoice",
];

/**
 * AJS/AJBR two-email shape (skill backend release contract / Captain 2026-08-04):
 * `report_invoice` then `photo` — not the universal three-email split.
 */
export const SES_AJS_ROUTE_ORDER: SesRouteKind[] = [
  "report_invoice",
  "photo",
];

/** MLB physical still uses the three-route order (report / photo / invoice). */
export const SES_MLB_PHYSICAL_ROUTE_ORDER: SesRouteKind[] = [
  ...SES_UNIVERSAL_ROUTE_ORDER,
];

/**
 * Machine-readable program consumed by the route resolver below and exported
 * into the canonical workflow hash. These are executable branch operands, not
 * prose labels: changing an admitted role, state, transform, or route shape
 * changes both runtime behavior and the contract hash input.
 */
export const SES_WORKFLOW_SEND_EXECUTION_POLICY = Object.freeze({
  schema_version: "secureworks.ses-send-execution-policy/v1",
  stored_route_order: Object.freeze([...SES_UNIVERSAL_ROUTE_ORDER]),
  artifact_path_resolution: Object.freeze({
    revision_precedence: Object.freeze([
      "current_docket_revision",
      "based_on_docket_revision",
    ]),
    admitted_roots: Object.freeze(["ARTIFACTS/", "SOURCE/", "DRAFTS/"]),
    terminal_fallback_segments: 2,
  }),
  artifact_roles: Object.freeze({
    xero_invoice_pdf: "xero_invoice_pdf",
    internal_invoice_proposal: "invoice_proposal",
    approved_invoice_support: Object.freeze([
      "supporting_report_pdf",
      "swms_artifact",
    ]),
  }),
  media_types: Object.freeze({ pdf: "application/pdf" }),
  pricing_dispositions: Object.freeze({
    no_additional_charge: "no_additional_charge",
  }),
  xero: Object.freeze({
    draft_status: "DRAFT",
    authorised_status: "AUTHORISED",
    authorised_docket_stage: "invoice_bound",
    binding_precedence: Object.freeze(["docket", "obligation"]),
  }),
  attachment_transforms: Object.freeze({
    stored_paths: "resolve_all_declared_paths_or_not_ready",
    invoice_support:
      "drop_internal_proposal_refuse_unknown_keep_pdf_report_and_swms",
    draft_invoice: "bind_exact_draft_pdf_then_support_dedupe_preserving_first",
    authorised_invoice:
      "bind_exact_authorised_pdf_then_support_dedupe_preserving_first",
    no_charge: "support_only_dedupe_preserving_first",
    ajs_combined:
      "invoice_pdf_then_report_then_invoice_support_dedupe_preserving_first",
    mlb_prime_invoice_guard: "hard_not_ready_never_strip",
  }),
  route_shapes: Object.freeze({
    ajs_physical: Object.freeze([...SES_AJS_ROUTE_ORDER]),
    mlb_physical: Object.freeze([...SES_MLB_PHYSICAL_ROUTE_ORDER]),
    universal_physical: Object.freeze([...SES_UNIVERSAL_ROUTE_ORDER]),
    report_photo: Object.freeze(["report", "photo"] as const),
    report_only: Object.freeze(["invoice"] as const),
  }),
  route_requirements: Object.freeze({
    assessment_family: "assessment_quote" as const,
    assessment_route_order: Object.freeze(["invoice"] as const),
  }),
  mlb_prime_route_kinds: Object.freeze(["report", "photo"] as const),
  subjects: Object.freeze({
    draft_status: "DRAFT" as const,
    authorised_status: "AUTHORISED" as const,
    pending_invoice_number: "pending-number" as const,
  }),
  internal_body_annotation: Object.freeze({
    pattern_source: String
      .raw`\b(?:drafts?|dockets?|packs?|routes?|cycles?|revisions?|threads?|threading|authorised|authorized)\b|mail\.send`,
    flags: "i" as const,
  }),
  client_send_gates: Object.freeze({
    by_route: Object.freeze(
      {
        report_invoice: "report_invoice",
        report: "report",
        photo: "photo",
        invoice: "invoice",
      } as const,
    ),
    ajs_legacy_report_gate: "report_invoice" as const,
  }),
  readiness: Object.freeze({
    missing_declared_artifact: "not_ready",
    unknown_invoice_attachment: "not_ready",
    empty_required_recipient_set: "not_ready",
    draft_requires_bound_pdf_hash: true,
    authorised_requires_exact_invoice_pdf: true,
  }),
});

export interface SesWorkflowResolvedRoute {
  route_kind: SesRouteKind;
  recipients: string[];
  cc?: string[];
  subject: string;
  body: string;
  attachment_hashes: string[];
  ready: boolean;
}

export type SesWorkflowSendProfileId =
  | "send.ajs.physical.v1"
  | "send.mlb.physical.v1"
  | "send.western.physical.v1"
  | "send.report_only.unsettled.v1"
  | "send.synthetic.disabled.v1";

export interface SesWorkflowSendProfileDescriptor {
  profile_id: SesWorkflowSendProfileId;
  seal_state: "sealed" | "unsealed";
  unsealed_reason_code:
    | "report_only_envelope_unsettled"
    | "synthetic_release_forbidden"
    | null;
  executable_send_recipe_id: SesWorkflowSendProfileId | null;
  route_order: readonly SesRouteKind[];
  send_rule_version: typeof SES_WORKFLOW_SEND_RULE_VERSION;
  executable_semantics: {
    execution_policy: typeof SES_WORKFLOW_SEND_EXECUTION_POLICY;
    route_requirement_policy: string;
    recipient_policy: string;
    recipient_constants: readonly string[];
    cc_policy: string;
    cc_constants: readonly string[];
    subject_policy: string;
    subject_templates: Readonly<Record<string, string>>;
    body_templates: Readonly<Record<string, string>>;
    attachment_policy: string;
    transformation_policy: string;
    stored_route_shape_policy: string;
  };
  live_effects_enabled: false;
  atomic_release_gate: "required_before_live_release";
  source_rule_ids: readonly string[];
}

function sesWorkflowPhysicalSendProfileForBuilder(
  builderKey: unknown,
): SesWorkflowSendProfileDescriptor {
  const base = {
    live_effects_enabled: false as const,
    atomic_release_gate: "required_before_live_release" as const,
    seal_state: "sealed" as const,
    unsealed_reason_code: null,
    send_rule_version:
      SES_WORKFLOW_SEND_RULE_VERSION as typeof SES_WORKFLOW_SEND_RULE_VERSION,
  };
  if (isAjsBuilderKey(builderKey)) {
    return Object.freeze({
      ...base,
      profile_id: "send.ajs.physical.v1",
      executable_send_recipe_id: "send.ajs.physical.v1",
      route_order: Object.freeze([...SES_AJS_ROUTE_ORDER]),
      executable_semantics: Object.freeze({
        execution_policy: SES_WORKFLOW_SEND_EXECUTION_POLICY,
        route_requirement_policy: "ajs-report-invoice-then-photo",
        recipient_policy: "ajs-workorders-plus-intake-participants",
        recipient_constants: Object.freeze([AJS_WORK_ORDERS_MAILBOX]),
        cc_policy: "ajs-permanent-builder-and-proof-cc",
        cc_constants: Object.freeze(ajsPackCc()),
        subject_policy: "ajs-bound-xero-state-and-job-reference",
        subject_templates: Object.freeze({
          authorised: "{job_ref} - report and Xero invoice {invoice_number}",
          draft: "{job_ref} - report and Xero draft {invoice_number}",
          no_additional_charge: "{job_ref} - report (no additional charge)",
          fallback: "{prepared_report_subject_or_job_ref} - report and invoice",
        }),
        body_templates: Object.freeze({
          report_invoice: sesAjsBuilderRouteBody(
            "report_invoice",
            "{job_ref}",
          ),
          report_no_additional_charge: sesAjsBuilderRouteBody(
            "report_invoice",
            "{job_ref}",
            { noAdditionalCharge: true },
          ),
          photo: sesAjsBuilderRouteBody("photo", "{job_ref}"),
        }),
        attachment_policy:
          "combined-report-authorised-invoice-support-then-photo-only",
        transformation_policy:
          "resolve-stored-paths-to-content-hashes-and-bind-xero-pdf",
        stored_route_shape_policy: "exact-report_invoice-photo",
      }),
      source_rule_ids: Object.freeze([
        "send.ajs.report-invoice-plus-photos.v1",
      ]),
    });
  }
  if (isMlbBuilderKey(builderKey)) {
    return Object.freeze({
      ...base,
      profile_id: "send.mlb.physical.v1",
      executable_send_recipe_id: "send.mlb.physical.v1",
      route_order: Object.freeze([...SES_MLB_PHYSICAL_ROUTE_ORDER]),
      executable_semantics: Object.freeze({
        execution_policy: SES_WORKFLOW_SEND_EXECUTION_POLICY,
        route_requirement_policy: "physical-report-photo-invoice",
        recipient_policy: "mlb-prime-report-photo-and-matrix-billing-invoice",
        recipient_constants: Object.freeze([MLB_PRIME_MAILER]),
        cc_policy: "none",
        cc_constants: Object.freeze([]),
        subject_policy:
          "verbatim-intake-subject-for-prime-routes-and-bound-xero-state-for-invoice",
        subject_templates: Object.freeze({
          report_photo: "{verbatim_intake_subject_or_prepared_subject}",
          invoice_authorised: "{job_ref} - Xero invoice {invoice_number}",
          invoice_draft: "{job_ref} - Xero draft {invoice_number}",
          invoice_no_additional_charge: "{job_ref} - no additional charge",
        }),
        body_templates: Object.freeze({
          report: sesBuilderRouteBody("report", "{job_ref}"),
          photo: sesBuilderRouteBody("photo", "{job_ref}"),
          invoice: sesBuilderRouteBody("invoice", "{job_ref}"),
          invoice_no_additional_charge: sesBuilderRouteBody(
            "invoice",
            "{job_ref}",
            { noAdditionalCharge: true },
          ),
        }),
        attachment_policy:
          "report-only-to-prime-photo-only-to-prime-authorised-invoice-report-swms-to-billing",
        transformation_policy:
          "resolve-stored-paths-to-content-hashes-bind-xero-pdf-and-refuse-invoice-on-prime",
        stored_route_shape_policy: "exact-report-photo-invoice",
      }),
      source_rule_ids: Object.freeze([
        "send.mlb.report-photo-invoice.v1",
      ]),
    });
  }
  return Object.freeze({
    ...base,
    profile_id: "send.western.physical.v1",
    executable_send_recipe_id: "send.western.physical.v1",
    route_order: Object.freeze([...SES_UNIVERSAL_ROUTE_ORDER]),
    executable_semantics: Object.freeze({
      execution_policy: SES_WORKFLOW_SEND_EXECUTION_POLICY,
      route_requirement_policy: "physical-report-photo-invoice",
      recipient_policy: "sealed-matrix-route-recipients",
      recipient_constants: Object.freeze([]),
      cc_policy: "none",
      cc_constants: Object.freeze([]),
      subject_policy: "job-reference-and-bound-xero-state",
      subject_templates: Object.freeze({
        authorised: "{job_ref} - Xero invoice {invoice_number}",
        draft: "{job_ref} - Xero draft {invoice_number}",
        no_additional_charge: "{job_ref} - no additional charge",
      }),
      body_templates: Object.freeze({
        report: sesBuilderRouteBody("report", "{job_ref}"),
        photo: sesBuilderRouteBody("photo", "{job_ref}"),
        invoice: sesBuilderRouteBody("invoice", "{job_ref}"),
        invoice_no_additional_charge: sesBuilderRouteBody(
          "invoice",
          "{job_ref}",
          { noAdditionalCharge: true },
        ),
      }),
      attachment_policy:
        "report-only-photo-only-authorised-invoice-with-approved-support",
      transformation_policy:
        "resolve-stored-paths-to-content-hashes-and-bind-xero-pdf",
      stored_route_shape_policy: "exact-report-photo-invoice",
    }),
    source_rule_ids: Object.freeze([
      "send.western.report-photo-invoice.v1",
    ]),
  });
}

/**
 * Family-aware send-profile selector for the contract registry.
 *
 * This describes route shape only. It deliberately cannot enable an effect:
 * live release remains behind the separate atomic lease/claim, exact-revision,
 * approval, money and effect-ledger guards. Report-only remains explicitly
 * unsealed until its owner-envelope mismatch is resolved.
 */
export function sesWorkflowSendProfile(
  row: SesFamilyMatrixRow,
): SesWorkflowSendProfileDescriptor {
  const base = {
    live_effects_enabled: false as const,
    atomic_release_gate: "required_before_live_release" as const,
    send_rule_version:
      SES_WORKFLOW_SEND_RULE_VERSION as typeof SES_WORKFLOW_SEND_RULE_VERSION,
  };
  if (row.builder_key === "SYNTHETIC") {
    return Object.freeze({
      ...base,
      profile_id: "send.synthetic.disabled.v1",
      seal_state: "unsealed",
      unsealed_reason_code: "synthetic_release_forbidden",
      executable_send_recipe_id: null,
      route_order: Object.freeze([]),
      executable_semantics: Object.freeze({
        execution_policy: SES_WORKFLOW_SEND_EXECUTION_POLICY,
        route_requirement_policy: "no-routes",
        recipient_policy: "none",
        recipient_constants: Object.freeze([]),
        cc_policy: "none",
        cc_constants: Object.freeze([]),
        subject_policy: "none",
        subject_templates: Object.freeze({}),
        body_templates: Object.freeze({}),
        attachment_policy: "none",
        transformation_policy: "none",
        stored_route_shape_policy: "release-forbidden",
      }),
      source_rule_ids: Object.freeze([
        "send.synthetic.release-forbidden.v1",
      ]),
    });
  }
  if (row.report_only) {
    return Object.freeze({
      ...base,
      profile_id: "send.report_only.unsettled.v1",
      seal_state: "unsealed",
      unsealed_reason_code: "report_only_envelope_unsettled",
      executable_send_recipe_id: null,
      route_order: Object.freeze(["invoice"] as SesRouteKind[]),
      executable_semantics: Object.freeze({
        execution_policy: SES_WORKFLOW_SEND_EXECUTION_POLICY,
        route_requirement_policy: "report-family-invoice-only-current-ruling",
        recipient_policy: "sealed-matrix-invoice-recipient",
        recipient_constants: Object.freeze([]),
        cc_policy: "none",
        cc_constants: Object.freeze([]),
        subject_policy: "job-reference-and-bound-xero-state",
        subject_templates: Object.freeze({
          authorised: "{job_ref} - Xero invoice {invoice_number}",
          draft: "{job_ref} - Xero draft {invoice_number}",
          no_additional_charge: "{job_ref} - no additional charge",
        }),
        body_templates: Object.freeze({
          invoice: sesBuilderRouteBody("invoice", "{job_ref}"),
          invoice_no_additional_charge: sesBuilderRouteBody(
            "invoice",
            "{job_ref}",
            { noAdditionalCharge: true },
          ),
        }),
        attachment_policy:
          "authorised-invoice-with-family-report-and-included-swms-when-present",
        transformation_policy:
          "resolve-stored-paths-to-content-hashes-and-bind-xero-pdf",
        stored_route_shape_policy: "exact-invoice-only",
      }),
      source_rule_ids: Object.freeze([
        "send.report-only-envelope-decision-open.v1",
      ]),
    });
  }
  return sesWorkflowPhysicalSendProfileForBuilder(row.builder_key);
}

export function isAjsBuilderKey(builderKey: unknown): boolean {
  const key = String(builderKey || "").trim().toUpperCase();
  return key === "AJS" || key === "AJBR";
}

export function sesReleaseRouteOrder(
  builderKey: unknown,
): SesRouteKind[] {
  return [...sesWorkflowPhysicalSendProfileForBuilder(builderKey).route_order];
}

/**
 * Family-owned route obligation selector consumed by both review and release.
 * Applicability defaults strict: an older producer can only require too much,
 * never silently omit a route.
 */
export function requiredSesRouteKinds(
  family: string,
  photoRouteApplicable: boolean,
  builderKey?: string | null,
  reportRouteApplicable = true,
): SesRouteKind[] {
  if (
    family ===
      SES_WORKFLOW_SEND_EXECUTION_POLICY.route_requirements.assessment_family
  ) {
    return [
      ...SES_WORKFLOW_SEND_EXECUTION_POLICY.route_requirements
        .assessment_route_order,
    ];
  }
  return sesReleaseRouteOrder(builderKey).filter((kind) =>
    (kind !== "photo" || photoRouteApplicable) &&
    (kind !== "report" || reportRouteApplicable)
  );
}

function canonicalSesRouteKindSetEquals(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return actual.length === expected.length &&
    expected.every((kind) => actual.includes(kind));
}

/** Resolve the only stored route sets the executable send contract admits. */
export function sesStoredReleaseRouteOrder(
  routeKinds: readonly string[],
): SesRouteKind[] | null {
  const unique = [...new Set(routeKinds.map((kind) => String(kind || "")))]
    .filter(Boolean);
  if (
    canonicalSesRouteKindSetEquals(
      unique,
      SES_WORKFLOW_SEND_EXECUTION_POLICY.route_shapes.ajs_physical,
    )
  ) {
    return [...SES_WORKFLOW_SEND_EXECUTION_POLICY.route_shapes.ajs_physical];
  }
  if (
    canonicalSesRouteKindSetEquals(
      unique,
      SES_WORKFLOW_SEND_EXECUTION_POLICY.route_shapes.report_photo,
    )
  ) {
    return [...SES_WORKFLOW_SEND_EXECUTION_POLICY.route_shapes.report_photo];
  }
  if (
    canonicalSesRouteKindSetEquals(
      unique,
      SES_WORKFLOW_SEND_EXECUTION_POLICY.route_shapes.report_only,
    )
  ) {
    return [...SES_WORKFLOW_SEND_EXECUTION_POLICY.route_shapes.report_only];
  }
  if (
    canonicalSesRouteKindSetEquals(
      unique,
      SES_WORKFLOW_SEND_EXECUTION_POLICY.route_shapes.universal_physical,
    )
  ) {
    return [...SES_UNIVERSAL_ROUTE_ORDER];
  }
  return null;
}

export function uniqueEmails(values: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const email = String(value || "").trim().toLowerCase();
    if (!email || !email.includes("@") || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

/**
 * AJS pack TO set: workorders@ajs.build plus any known thread participants
 * (work-order sender and extra participant list).
 */
export function ajsPackRecipients(args: {
  workOrderSender?: string | null;
  threadParticipants?: string[] | null;
}): string[] {
  return uniqueEmails([
    AJS_WORK_ORDERS_MAILBOX,
    args.workOrderSender,
    ...(args.threadParticipants || []),
  ]);
}

/**
 * Authoritative AJS/AJBR pack CC set (Captain 2026-08-06).
 * Order is stable: SecureWorks proof surface first, then permanent builder CCs.
 * This function is the single producer for sealed SES release routes; legacy
 * makesafe_send_pack and recipient gates must consume the same list.
 */
export function ajsPackCc(): string[] {
  return uniqueEmails([
    SES_RELEASE_CC,
    AJS_VANESSA_CC,
    AJS_MANDI_CC,
  ]);
}

/**
 * Authoritative MLB physical destination per route (Captain 2026-08-06).
 *
 *   invoice — the sealed matrix billing mailbox (`makesafes@mlbuilders.com.au`,
 *             or the south-west `bunbury@` row): invoice + SWMS + report TOGETHER.
 *   report  — the Prime mailer, on the verbatim work-order subject, report only.
 *   photo   — the Prime mailer, all photos, and nothing else.
 *
 * This is the SINGLE producer for those three destinations. Both the prepare
 * draft (`buildEmailDrafts`, what the operator reads) and the resolved release
 * route (`resolveDocketRoutes`, what the cockpit renders and execute sends)
 * consume it, so the two stores cannot drift apart again.
 *
 * Why a sealed constant and not the company row: MLB's
 * `makesafe_companies.report_recipient` IS `makesafes@mlbuilders.com.au`, so
 * `report_route: "work_order_sender"` resolved report and photo to the billing
 * mailbox and all three MLB emails landed in one inbox — the Prime mailer never
 * received anything. `sender_patterns` is an inbound trust list and must never
 * auto-select a destination, so the mailer address is declared here instead.
 *
 * `billingMailbox` stays caller-supplied because the matrix already picks
 * Perth vs south-west; this function must not re-decide that.
 */
export function mlbPhysicalRouteRecipients(
  routeKind: SesRouteKind,
  billingMailbox: string | null | undefined,
): string[] {
  if (routeKind === "report" || routeKind === "photo") {
    return uniqueEmails([MLB_PRIME_MAILER]);
  }
  return uniqueEmails([billingMailbox]);
}

/** True when this route is one of the two MLB Prime mailer routes. */
export function isMlbPrimeMailerRouteKind(routeKind: SesRouteKind): boolean {
  return SES_WORKFLOW_SEND_EXECUTION_POLICY.mlb_prime_route_kinds.includes(
    routeKind as "report" | "photo",
  );
}

/**
 * Captain's absolute boundary: NO invoice on either Prime mailer route.
 *
 * The report and photo routes are composed from the report PDF and the photo
 * set respectively, so this can only fire if a future change lets the bound Xero
 * invoice PDF onto one of them. It returns true rather than filtering, because
 * the honest answer to "this pack would mail the builder's invoice to the
 * mailer" is to refuse the route, not to quietly reshape it.
 */
export function mlbPrimeMailerRouteCarriesInvoice(args: {
  routeKind: SesRouteKind;
  attachmentHashes: readonly string[];
  invoicePdfContentHash?: string | null;
}): boolean {
  if (!isMlbPrimeMailerRouteKind(args.routeKind)) return false;
  const invoiceHash = String(args.invoicePdfContentHash || "").trim();
  if (!invoiceHash) return false;
  return (args.attachmentHashes || []).some((hash) =>
    String(hash || "").trim() === invoiceHash
  );
}

/**
 * Builder-facing body copy for sealed release routes (live leak SWMS-261161 /
 * SWMS-261158, 2026-08-10/13): plain client English only — what is attached,
 * the job reference, a thank-you. The stored `email_drafts` keep their
 * operator annotations for the docket display surface; this producer is what
 * every OUTBOUND route body must come from. AJS/AJBR keep their own pinned
 * two-email wording in resolveDocketRoutes; every other shape (MLB physical,
 * ordinary-mail exception included, and the universal three-route split) sets
 * bodies here so a stored annotation can never ride out on a release again.
 */
export function sesBuilderRouteBody(
  routeKind: "report" | "photo" | "invoice",
  jobRef: string | null | undefined,
  options?: { noAdditionalCharge?: boolean },
): string {
  const ref = String(jobRef || "").trim() || "this job";
  if (routeKind === "photo") {
    return `Please find attached site photos for ${ref}.\n\nThank you.`;
  }
  if (routeKind === "invoice") {
    if (options?.noAdditionalCharge) {
      return `Please find attached the supporting documents for ${ref}. There is no additional charge for this attendance.\n\nThank you.`;
    }
    return `Please find attached the invoice and supporting documents for ${ref}.\n\nThank you.`;
  }
  return `Please find attached the report for ${ref}.\n\nThank you.`;
}

export function sesInvoiceRouteSubject(args: {
  jobRef?: string | null;
  xeroStatus?: string | null;
  invoiceNumber?: string | null;
  noAdditionalCharge?: boolean;
}): string {
  const ref = String(args.jobRef || "").trim() || "Make-safe";
  if (args.noAdditionalCharge) return `${ref} - no additional charge`;
  const status = String(args.xeroStatus || "").trim().toUpperCase();
  const invoiceNumber = String(args.invoiceNumber || "").trim();
  if (status === SES_WORKFLOW_SEND_EXECUTION_POLICY.subjects.draft_status) {
    return `${ref} - Xero draft ${
      invoiceNumber ||
      SES_WORKFLOW_SEND_EXECUTION_POLICY.subjects.pending_invoice_number
    }`;
  }
  return `${ref} - Xero invoice ${invoiceNumber}`.trim();
}

export function sesAjsReportInvoiceSubject(args: {
  jobRef?: string | null;
  xeroStatus?: string | null;
  invoiceNumber?: string | null;
  boundInvoiceId?: string | null;
  noAdditionalCharge?: boolean;
  preparedReportSubject?: string | null;
}): string {
  const ref = String(args.jobRef || "").trim() || "Make-safe";
  if (args.noAdditionalCharge) {
    return `${ref} - report (no additional charge)`;
  }
  const invoiceNumber = String(args.invoiceNumber || "").trim();
  const status = String(args.xeroStatus || "").trim().toUpperCase();
  if (
    status === SES_WORKFLOW_SEND_EXECUTION_POLICY.subjects.authorised_status
  ) {
    return `${ref} - report and Xero invoice ${invoiceNumber}`.trim();
  }
  if (
    status === SES_WORKFLOW_SEND_EXECUTION_POLICY.subjects.draft_status &&
    String(args.boundInvoiceId || "").trim()
  ) {
    return `${ref} - report and Xero draft ${
      invoiceNumber ||
      SES_WORKFLOW_SEND_EXECUTION_POLICY.subjects.pending_invoice_number
    }`
      .trim();
  }
  return String(args.preparedReportSubject || "").trim() ||
    `${ref} - report and invoice`;
}

/** Exact AJS/AJBR two-route builder copy, owned beside its send profile. */
export function sesAjsBuilderRouteBody(
  routeKind: "report_invoice" | "photo",
  jobRef: string | null | undefined,
  options?: { noAdditionalCharge?: boolean },
): string {
  const ref = String(jobRef || "").trim() || "this job";
  if (routeKind === "photo") {
    return `Please find attached site photos for ${ref}.\n\nThank you.`;
  }
  if (options?.noAdditionalCharge) {
    return `Please find attached the report for ${ref}. There is no additional charge for this attendance.\n\nThank you.`;
  }
  return `Please find attached the report and invoice for ${ref}.\n\nThank you.`;
}

function routeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

function dedupeRouteValues(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => String(value || "")))].filter(
    Boolean,
  );
}

/** Exact artifact-path program owned and hashed with the send contract. */
export function sesRouteArtifactPackRelativePath(
  objectKey: string,
  docketRevisionId: string,
  basedOnRevisionId?: string | null,
): string {
  const key = String(objectKey || "");
  if (!key) return "";
  const markers: string[] = [];
  const current = String(docketRevisionId || "").trim();
  if (current) markers.push(`/${current}/`);
  const basedOn = String(basedOnRevisionId || "").trim();
  if (basedOn && basedOn !== current) markers.push(`/${basedOn}/`);
  for (const marker of markers) {
    const index = key.indexOf(marker);
    if (index >= 0) return key.slice(index + marker.length);
  }
  for (
    const root of SES_WORKFLOW_SEND_EXECUTION_POLICY.artifact_path_resolution
      .admitted_roots
  ) {
    const withSlash = `/${root}`;
    const index = key.indexOf(withSlash);
    if (index >= 0) return key.slice(index + 1);
    if (key.startsWith(root)) return key;
  }
  return key.split("/").filter(Boolean).slice(
    -SES_WORKFLOW_SEND_EXECUTION_POLICY.artifact_path_resolution
      .terminal_fallback_segments,
  ).join("/");
}

/** Docket binding outranks obligation binding, as declared in the policy. */
export function sesRouteXeroBinding(
  docket: Record<string, unknown>,
  obligation: Record<string, unknown> | null,
): Record<string, unknown> {
  const docketXero = routeObject(docket.xero_binding);
  if (String(docketXero.xero_invoice_id || "").trim()) return docketXero;
  const obligationXero = routeObject(obligation?.xero_binding);
  if (String(obligationXero.xero_invoice_id || "").trim()) {
    return obligationXero;
  }
  return {};
}

function routeBuilderKey(docket: Record<string, unknown>): string {
  const classification = routeObject(
    routeObject(routeObject(docket.envelope).v2).classification,
  );
  return String(
    classification.builder_key ||
      routeObject(docket.review_spec).builder_key ||
      "",
  ).trim();
}

/**
 * The only executable SES route/envelope selector. Reporting actions adapt
 * stored drafts into typed routes, then delegate every recipient, attachment,
 * Xero-state, AJS-combine, and MLB transform here.
 */
export function resolveSesWorkflowRoutes(args: {
  docket: Record<string, unknown>;
  artifacts: Array<Record<string, unknown>>;
  obligation: Record<string, unknown> | null;
  stored_routes: SesWorkflowResolvedRoute[];
  mlb_ordinary_mail_send_fallback?: boolean;
}): SesWorkflowResolvedRoute[] {
  const { docket, artifacts, obligation } = args;
  const policy = SES_WORKFLOW_SEND_EXECUTION_POLICY;
  const byPath = new Map<string, Record<string, unknown>>();
  const basedOnRevisionId = String(docket.based_on_revision_id || "").trim();
  for (const artifact of artifacts) {
    const path = sesRouteArtifactPackRelativePath(
      String(artifact.object_key || ""),
      String(docket.id || ""),
      basedOnRevisionId,
    );
    if (path) byPath.set(path, artifact);
  }
  const xero = sesRouteXeroBinding(docket, obligation);
  const boundInvoiceId = String(xero.xero_invoice_id || "");
  const boundInvoiceNumber = String(xero.invoice_number || "");
  const xeroStatus = String(xero.status || "").toUpperCase();
  const draftInvoicePdfHash = xeroStatus === policy.xero.draft_status
    ? String(xero.pdf_content_hash || "").trim()
    : "";
  const invoicePdfs = artifacts.filter((artifact) =>
    artifact.role === policy.artifact_roles.xero_invoice_pdf &&
    artifact.media_type === policy.media_types.pdf
  );
  const invoicePdf = invoicePdfs.length === 1 &&
      routeObject(invoicePdfs[0].metadata).xero_invoice_id === boundInvoiceId &&
      routeObject(invoicePdfs[0].metadata).invoice_number === boundInvoiceNumber
    ? invoicePdfs[0]
    : null;
  const noAdditionalCharge = obligation?.pricing_disposition ===
    policy.pricing_dispositions.no_additional_charge;
  const builderKey = routeBuilderKey(docket);
  const ajs = isAjsBuilderKey(builderKey);
  const manifest = routeObject(routeObject(docket.envelope).v2);
  const routing = routeObject(manifest.routing);
  const workOrderSender = String(
    routing.report_to || routing.photo_to || "",
  ).trim();
  const localInvoiceProposal = routeObject(docket.local_invoice_proposal);
  const builderReference = String(
    localInvoiceProposal.builder_reference || "",
  ).trim();

  const resolvedRoutes = args.stored_routes.map((route) => {
    const referenced = route.attachment_hashes.map((path) => byPath.get(path));
    const resolved = referenced.filter(
      (artifact): artifact is Record<string, unknown> => !!artifact,
    ).map((artifact) => String(artifact.content_hash));
    if (route.route_kind !== "invoice") {
      return {
        ...route,
        body: sesBuilderRouteBody(
          route.route_kind === "photo" ? "photo" : "report",
          builderReference,
        ),
        attachment_hashes: resolved,
        ready: route.ready &&
          resolved.length === route.attachment_hashes.length,
      };
    }

    const approvedSupport = referenced.filter((artifact) =>
      artifact &&
      policy.artifact_roles.approved_invoice_support.includes(
        String(artifact.role) as
          | "supporting_report_pdf"
          | "swms_artifact",
      ) && artifact.media_type === policy.media_types.pdf
    ) as Array<Record<string, unknown>>;
    const unsupportedReference = referenced.some((artifact) =>
      !artifact ||
      (artifact.role !== policy.artifact_roles.internal_invoice_proposal &&
        !approvedSupport.includes(artifact))
    );
    const supportHashes = approvedSupport.map((artifact) =>
      String(artifact.content_hash)
    );
    const reference = String(localInvoiceProposal.builder_reference || "");

    if (noAdditionalCharge) {
      return {
        ...route,
        subject: sesInvoiceRouteSubject({
          jobRef: reference,
          noAdditionalCharge: true,
        }),
        body: sesBuilderRouteBody("invoice", builderReference, {
          noAdditionalCharge: true,
        }),
        attachment_hashes: dedupeRouteValues(supportHashes),
        ready: route.ready && !unsupportedReference,
      };
    }

    if (boundInvoiceId && xeroStatus === policy.xero.draft_status) {
      const invoiceNumber = boundInvoiceNumber || "pending-number";
      return {
        ...route,
        subject: sesInvoiceRouteSubject({
          jobRef: reference,
          xeroStatus,
          invoiceNumber,
        }),
        body: sesBuilderRouteBody("invoice", builderReference),
        attachment_hashes: dedupeRouteValues([
          ...(draftInvoicePdfHash ? [draftInvoicePdfHash] : []),
          ...supportHashes,
        ]),
        ready: route.ready && !!draftInvoicePdfHash && !unsupportedReference,
      };
    }

    if (
      docket.stage !== policy.xero.authorised_docket_stage ||
      xeroStatus !== policy.xero.authorised_status
    ) {
      return {
        ...route,
        body: sesBuilderRouteBody("invoice", builderReference),
        attachment_hashes: dedupeRouteValues(supportHashes),
        ready: false,
      };
    }
    const invoiceAttachments = [...supportHashes];
    if (invoicePdf?.content_hash) {
      invoiceAttachments.unshift(String(invoicePdf.content_hash));
    }
    return {
      ...route,
      subject: sesInvoiceRouteSubject({
        jobRef: reference,
        xeroStatus,
        invoiceNumber: boundInvoiceNumber,
      }),
      body: sesBuilderRouteBody("invoice", builderReference),
      attachment_hashes: dedupeRouteValues(invoiceAttachments),
      ready: route.ready && !!invoicePdf?.content_hash &&
        xeroStatus === policy.xero.authorised_status && !unsupportedReference,
    };
  });

  if (!ajs) {
    const classification = routeObject(manifest.classification);
    const family = String(
      classification.family || routeObject(docket.review_spec).family || "",
    );
    const shape = { builder_key: builderKey, family };
    if (!isMlbPhysicalReleaseShape(shape)) return resolvedRoutes;
    const thread = routingIntakeThread(routing);
    const billingMailbox = String(routing.invoice_to || "").trim();
    const invoicePdfHash = String(
      invoicePdf?.content_hash || draftInvoicePdfHash || "",
    ).trim() || null;
    const ordinaryMailSend = args.mlb_ordinary_mail_send_fallback ??
      mlbPhysicalUsesOrdinaryMailSendFallback();
    const originalSubject = String(
      routing.intake_email_subject || "",
    ).trim() || null;
    const originalSubjectSourceRaw = String(
      routing.intake_email_subject_source || "",
    ).trim();
    const originalSubjectSource =
      originalSubjectSourceRaw === "emails_subject" ||
        originalSubjectSourceRaw === "intake_draft_subject" ||
        originalSubjectSourceRaw === "job_metadata_builder_email_subject"
        ? originalSubjectSourceRaw
        : null;
    return resolvedRoutes.map((route) => {
      const declared = mlbPhysicalRouteRecipients(
        route.route_kind,
        billingMailbox,
      );
      const recipients = declared.length > 0 ? declared : route.recipients;
      const invoiceOnMailerRoute = mlbPrimeMailerRouteCarriesInvoice({
        routeKind: route.route_kind,
        attachmentHashes: route.attachment_hashes,
        invoicePdfContentHash: invoicePdfHash,
      });
      return applyMlbThreadReplyToRoute(
        {
          ...route,
          recipients,
          ready: route.ready && recipients.length > 0 &&
            !invoiceOnMailerRoute,
        },
        shape,
        thread,
        ordinaryMailSend,
        ordinaryMailSend ? { originalSubject, originalSubjectSource } : null,
      );
    });
  }

  const byKind = new Map(
    resolvedRoutes.map((route) => [route.route_kind, route]),
  );
  const report = byKind.get("report");
  const photo = byKind.get("photo");
  const invoice = byKind.get("invoice");
  const recipients = ajsPackRecipients({ workOrderSender });
  const cc = ajsPackCc();
  const out: SesWorkflowResolvedRoute[] = [];
  const reference = String(localInvoiceProposal.builder_reference || "");
  const jobRef = reference || "this job";

  if (report || invoice) {
    const reportHashes = report?.attachment_hashes || [];
    const invoiceHashes = (invoice?.attachment_hashes || []).filter(Boolean);
    const combinedHashes = dedupeRouteValues([
      ...(invoicePdf?.content_hash
        ? [String(invoicePdf.content_hash)]
        : (draftInvoicePdfHash ? [draftInvoicePdfHash] : [])),
      ...reportHashes,
      ...invoiceHashes,
    ]);
    const authorised = xeroStatus === policy.xero.authorised_status &&
      !!invoicePdf?.content_hash;
    const combined: SesWorkflowResolvedRoute = {
      route_kind: "report_invoice",
      recipients,
      cc,
      subject: sesAjsReportInvoiceSubject({
        jobRef: reference,
        xeroStatus,
        invoiceNumber: boundInvoiceNumber,
        boundInvoiceId,
        preparedReportSubject: report?.subject,
      }),
      body: sesAjsBuilderRouteBody("report_invoice", jobRef),
      attachment_hashes: combinedHashes,
      ready: !!report?.ready && authorised && recipients.length > 0,
    };
    if (noAdditionalCharge && report) {
      combined.subject = sesAjsReportInvoiceSubject({
        jobRef: reference,
        noAdditionalCharge: true,
      });
      combined.body = sesAjsBuilderRouteBody("report_invoice", jobRef, {
        noAdditionalCharge: true,
      });
      combined.attachment_hashes = dedupeRouteValues(reportHashes);
      combined.ready = report.ready && recipients.length > 0;
    }
    out.push(combined);
  }

  if (photo) {
    out.push({
      ...photo,
      route_kind: "photo",
      body: sesAjsBuilderRouteBody("photo", jobRef),
      recipients: recipients.length ? recipients : photo.recipients,
      cc,
      ready: photo.ready &&
        (recipients.length > 0 || photo.recipients.length > 0),
    });
  }
  return out;
}

/**
 * Detects internal draft-annotation vocabulary in an outbound email body.
 *
 * The execute path refuses to dispatch any route whose PERSISTED body still
 * trips this — a release prepared before the body producers were fixed (or a
 * caller-passed stale route set) fails closed with "prepare a new release
 * revision" instead of mailing the builder an internal annotation. Bodies from
 * sesBuilderRouteBody / the pinned AJS wording never contain these terms, so a
 * refusal always means a stale or hand-rolled body, not a producer bug.
 */
const SES_INTERNAL_BODY_ANNOTATION_RE = new RegExp(
  SES_WORKFLOW_SEND_EXECUTION_POLICY.internal_body_annotation.pattern_source,
  SES_WORKFLOW_SEND_EXECUTION_POLICY.internal_body_annotation.flags,
);

export function sesBodyCarriesInternalAnnotation(body: unknown): boolean {
  return SES_INTERNAL_BODY_ANNOTATION_RE.test(String(body || ""));
}

/**
 * Skill contract gate kinds — exact names from the backend release contract table.
 */
export type SesClientSendGateKind =
  | "report_invoice"
  | "report"
  | "photo"
  | "invoice";

/**
 * Map a release route_kind (+ builder) to the client-send gate kind.
 * AJS `report_invoice` route → gate `report_invoice`; never silent-map to `report`.
 */
export function clientSendGateKindForRoute(args: {
  routeKind: SesRouteKind;
  builderKey?: unknown;
}): SesClientSendGateKind {
  const gates = SES_WORKFLOW_SEND_EXECUTION_POLICY.client_send_gates;
  if (args.routeKind === "report_invoice") {
    return gates.by_route.report_invoice;
  }
  // Legacy half-match: AJS stored as route_kind report still means combined.
  if (args.routeKind === "report" && isAjsBuilderKey(args.builderKey)) {
    return gates.ajs_legacy_report_gate;
  }
  return gates.by_route[args.routeKind];
}
