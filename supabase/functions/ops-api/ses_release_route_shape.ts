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
import { isMlbBuilderKey } from "./ses_mlb_thread_reply.ts";

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

export const SES_WORKFLOW_SEND_RULE_VERSION = "ses-workflow-send/2026-08-14.1";

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
    send_rule_version: "ses-workflow-send/2026-08-14.1" as const,
  };
  if (isAjsBuilderKey(builderKey)) {
    return Object.freeze({
      ...base,
      profile_id: "send.ajs.physical.v1",
      executable_send_recipe_id: "send.ajs.physical.v1",
      route_order: Object.freeze([...SES_AJS_ROUTE_ORDER]),
      executable_semantics: Object.freeze({
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
    send_rule_version: "ses-workflow-send/2026-08-14.1" as const,
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
  if (family === "assessment_quote") return ["invoice"];
  return sesReleaseRouteOrder(builderKey).filter((kind) =>
    (kind !== "photo" || photoRouteApplicable) &&
    (kind !== "report" || reportRouteApplicable)
  );
}

/** Resolve the only stored route sets the executable send contract admits. */
export function sesStoredReleaseRouteOrder(
  routeKinds: readonly string[],
): SesRouteKind[] | null {
  const unique = [...new Set(routeKinds.map((kind) => String(kind || "")))]
    .filter(Boolean);
  if (
    unique.length === 2 && unique.includes("photo") &&
    unique.includes("report_invoice")
  ) {
    return [...SES_AJS_ROUTE_ORDER];
  }
  if (
    unique.length === 2 && unique.includes("photo") &&
    unique.includes("report")
  ) {
    return ["report", "photo"];
  }
  if (unique.length === 1 && unique[0] === "invoice") return ["invoice"];
  if (
    unique.length === SES_UNIVERSAL_ROUTE_ORDER.length &&
    SES_UNIVERSAL_ROUTE_ORDER.every((kind) => unique.includes(kind))
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
  return routeKind === "report" || routeKind === "photo";
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
  if (status === "DRAFT") {
    return `${ref} - Xero draft ${invoiceNumber || "pending-number"}`;
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
  if (status === "AUTHORISED") {
    return `${ref} - report and Xero invoice ${invoiceNumber}`.trim();
  }
  if (status === "DRAFT" && String(args.boundInvoiceId || "").trim()) {
    return `${ref} - report and Xero draft ${invoiceNumber || "pending-number"}`
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
const SES_INTERNAL_BODY_ANNOTATION_RE =
  /\b(?:drafts?|dockets?|packs?|routes?|cycles?|revisions?|threads?|threading|authorised|authorized)\b|mail\.send/i;

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
  if (args.routeKind === "report_invoice") return "report_invoice";
  // Legacy half-match: AJS stored as route_kind report still means combined.
  if (args.routeKind === "report" && isAjsBuilderKey(args.builderKey)) {
    return "report_invoice";
  }
  if (args.routeKind === "report") return "report";
  if (args.routeKind === "photo") return "photo";
  return "invoice";
}
