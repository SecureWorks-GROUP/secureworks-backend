// Builder-scoped SES release route shapes.
//
// Captain ruling 2026-08-04 (AJS/AJBR only):
//   two emails — (A) report + invoice together, (B) photos follow-up;
//   TO workorders@ajs.build + thread participants; from admin@.
//
// Captain ruling 2026-08-06 (AJS/AJBR permanent builder CCs), superseded for
// AJBR by the Captain's 2026-08-24 recipient ruling below:
//   AJS completion docs keep ses@ + vanessa@ajs.build + mandi@ajs.build.
//   AJBR completion docs CC finance@ only; AJBR no longer CCs ses@.
//   Every photo route has no CC, regardless of builder.
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
//
// Shaun 2026-08-20 (report route only):
//   EVERY non-AJS `report` route CCs ses@secureworkswa.com.au - MLB physical
//   included, alongside MLB report-only families and every other non-AJS
//   builder. Every photo route carries no cc, and the invoice billing pack keeps
//   finance@ and still never ccs ses@. Producer: sesReleaseRouteCc().
//   Supersedes the 2026-07-21 ses@ removal for THAT ROUTE only.

import type { SesRouteKind } from "./ses_review_cockpit.ts";
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

export const SES_FINANCE_CC = "finance@secureworkswa.com.au";

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

export function isAjsBuilderKey(builderKey: unknown): boolean {
  const key = String(builderKey || "").trim().toUpperCase();
  return key === "AJS" || key === "AJBR";
}

export function isAjbrBuilderKey(builderKey: unknown): boolean {
  return String(builderKey || "").trim().toUpperCase() === "AJBR";
}

export function sesReleaseRouteOrder(
  builderKey: unknown,
): SesRouteKind[] {
  return isAjsBuilderKey(builderKey)
    ? [...SES_AJS_ROUTE_ORDER]
    : [...SES_UNIVERSAL_ROUTE_ORDER];
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
 * The AJS permanent pack CC set (Captain 2026-08-06).
 * Order is stable: SecureWorks proof surface first, then permanent builder CCs.
 * AJBR sealed releases no longer consume this set after the Captain's
 * 2026-08-24 ruling; legacy makesafe_send_pack still does until that separate
 * send path is retired or migrated.
 */
export function ajsPackCc(): string[] {
  return uniqueEmails([
    SES_RELEASE_CC,
    AJS_VANESSA_CC,
    AJS_MANDI_CC,
  ]);
}

/**
 * Report-route CC for every non-AJS builder (Shaun, 2026-08-20).
 *
 * Scope is exactly the `report` route, and it is shape-independent: MLB
 * physical, MLB report-only families and every other non-AJS builder all cc
 * ses@ on the report. It supersedes the 2026-07-21 removal of ses@ FROM THAT
 * ONE ROUTE and nothing else:
 *
 *   - the photo route carries no cc for every builder;
 *   - the invoice billing pack keeps finance@ and still never ccs ses@;
 *   - AJS completion docs keep ajsPackCc(); AJBR completion docs use finance.
 *
 * Single producer for the draft (`buildEmailDrafts`) and the gate, so the
 * envelope the operator reads and the envelope the gate grades cannot drift.
 * Because no shape is exempt, nothing has to classify the card to get the cc
 * right - there is no undeclared-shape path back to the superseded envelope.
 */
export function universalReportCc(): string[] {
  return uniqueEmails([SES_RELEASE_CC]);
}

/**
 * Canonical CC list for one sealed SES release route.
 *
 * Captain 2026-08-24:
 *   - AJBR completion documents (`report_invoice`, including its stored
 *     pre-combine `report` draft) CC finance only;
 *   - every photo route has no CC, for every builder;
 *   - AJS and every non-AJBR report/invoice route keep their prior recipients.
 *
 * Draft construction, resolved cockpit routes, client-send gates and SEND IT
 * all consume this producer so the operator preview and Graph envelope agree.
 */
export function sesReleaseRouteCc(args: {
  routeKind: SesRouteKind;
  builderKey?: unknown;
}): string[] {
  if (args.routeKind === "photo") return [];
  if (args.routeKind === "invoice") return uniqueEmails([SES_FINANCE_CC]);
  if (isAjbrBuilderKey(args.builderKey)) {
    return uniqueEmails([SES_FINANCE_CC]);
  }
  if (isAjsBuilderKey(args.builderKey)) return ajsPackCc();
  return universalReportCc();
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
