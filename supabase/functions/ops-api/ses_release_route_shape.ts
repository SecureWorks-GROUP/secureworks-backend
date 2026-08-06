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

import type { SesRouteKind } from "./ses_review_cockpit.ts";
import {
  AJS_MANDI_CC,
  AJS_VANESSA_CC,
  AJS_WORK_ORDERS_MAILBOX,
  SES_RELEASE_CC,
} from "./ses_graph_mail_gateway.ts";
import { isMlbBuilderKey } from "./ses_mlb_thread_reply.ts";

export {
  AJS_MANDI_CC,
  AJS_VANESSA_CC,
  AJS_WORK_ORDERS_MAILBOX,
  isMlbBuilderKey,
  SES_RELEASE_CC,
};

export type SesReleaseBuilderKey = "AJS" | "AJBR" | "MLB" | "WESTERN" | string;

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
