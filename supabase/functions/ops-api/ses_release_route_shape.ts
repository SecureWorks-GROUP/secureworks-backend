// Builder-scoped SES release route shapes.
//
// Captain ruling 2026-08-04 (AJS/AJBR only):
//   two emails — (A) report + invoice together, (B) photos follow-up;
//   TO workorders@ajs.build + thread participants; CC ses@; from admin@.
// MLB and every other builder keep the three-route shape (report, photo, invoice).

import type { SesRouteKind } from "./ses_review_cockpit.ts";
import {
  AJS_WORK_ORDERS_MAILBOX,
  SES_RELEASE_CC,
} from "./ses_graph_mail_gateway.ts";

export { AJS_WORK_ORDERS_MAILBOX, SES_RELEASE_CC };

export type SesReleaseBuilderKey = "AJS" | "AJBR" | "MLB" | "WESTERN" | string;

export const SES_UNIVERSAL_ROUTE_ORDER: SesRouteKind[] = [
  "report",
  "photo",
  "invoice",
];

/** AJS/AJBR: report route carries the real Xero invoice PDF; no separate invoice email. */
export const SES_AJS_ROUTE_ORDER: SesRouteKind[] = ["report", "photo"];

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

export function ajsPackCc(): string[] {
  return [SES_RELEASE_CC];
}

export type SesClientSendGateKind =
  | "universal_report"
  | "universal_photo"
  | "universal_invoice"
  | "ajs_report_invoice"
  | "ajs_photo";

/**
 * Map a release route_kind + builder to the client-send gate kind the payload
 * must satisfy. AJS report is the combined report+invoice gate; AJS has no
 * separate invoice route.
 */
export function clientSendGateKindForRoute(args: {
  routeKind: SesRouteKind;
  builderKey?: unknown;
}): SesClientSendGateKind {
  if (isAjsBuilderKey(args.builderKey)) {
    if (args.routeKind === "report") return "ajs_report_invoice";
    if (args.routeKind === "photo") return "ajs_photo";
  }
  if (args.routeKind === "report") return "universal_report";
  if (args.routeKind === "photo") return "universal_photo";
  return "universal_invoice";
}
