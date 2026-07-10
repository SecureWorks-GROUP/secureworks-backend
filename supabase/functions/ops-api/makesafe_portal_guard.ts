// MakeSafe portal-truth guard + recheck-queue predicates (M-E1 / W2-C).
//
// Pure helpers only: no network, no Supabase, no live sends — so the item-14
// guard and the honest-fallback recheck queue are unit-testable against fixtured
// portal states. The DB reads/writes live in index.ts; this file is the decision
// logic those handlers call.
//
// Item 14 ("graf"): 8+ roof-report cards carried ready_to_invoice and/or auto-cut
// Xero DRAFT invoices while their primeeco portal form was never submitted. The
// rule these helpers enforce: no AUTOMATED path may advance a report-type card's
// substatus to a report-complete state, or draft its invoice, without a RECORDED
// portal-locked verification for the card's CURRENT work cycle.

import { urlIsBuilderPortalLink } from "./makesafe_email_links.ts";

// Report-complete substatuses. Reaching any of these on a report-type card means
// "the trade's portal report is in / ready to send / ready to invoice" — which is
// exactly what a portal-locked verification is supposed to prove first. The
// pre-report substatuses (company_contact_required / _done, waiting_on_trade_report)
// are NOT guarded: a card is free to move through them before the portal is done.
export const PORTAL_GUARDED_ADVANCE_SUBSTATUSES = [
  "admin_to_send_report",
  "ready_to_invoice",
  "complete",
] as const;

export type PortalVerificationState = {
  // Is this a report-type card (portal report lives on the builder side)? Non-
  // report make-safes are never gated here — they submit a real crew report.
  isReportType: boolean;
  // Current work cycle (makesafe_job_details.cycle_number; defaults to 1).
  currentCycle: number;
  // Recorded verification (makesafe_job_details.portal_verified_*).
  verifiedAt: string | null;
  verifiedCycle: number | null;
};

// A report-type card is portal-verified only when a verification was recorded FOR
// THE CURRENT cycle. A reopen/re-attend bumps cycle_number, so a stale prior-cycle
// verification does not carry over. Non-report cards are always "satisfied" (this
// guard does not apply to them).
export function portalVerificationSatisfied(
  state: PortalVerificationState,
): boolean {
  if (!state.isReportType) return true;
  if (!state.verifiedAt) return false;
  return Number(state.verifiedCycle) === Number(state.currentCycle);
}

// Does advancing to `nextSubstatus` on this card require a portal-locked
// verification first? Only report-type cards moving to a report-complete substatus.
export function substatusAdvanceNeedsPortalVerification(
  nextSubstatus: string | null | undefined,
  isReportType: boolean,
): boolean {
  if (!isReportType) return false;
  return (PORTAL_GUARDED_ADVANCE_SUBSTATUSES as readonly string[]).includes(
    String(nextSubstatus || ""),
  );
}

// ── Report-in guard (M-G FIX 1) ─────────────────────────────────────────────
// The portal guard above owns REPORT-type cards (roof/assessment: the report
// lives in the builder's portal). Its physical twin: a NON-report make-safe must
// have OUR OWN trade report filed in our system before it can advance to a
// report-complete substatus or have its invoice cut. Same guarded substatuses,
// same current-cycle rule. Proof (the dual definition makesafeAudit already uses):
// a job_service_reports row status in (submitted, approved) for the current cycle
// OR a typed job_documents row of type 'makesafe_report' filed on the job.
export type ReportInState = {
  // Is this a make-safe job at all (a makesafe_job_details row exists)? The guard
  // no-ops for non-make-safe jobs so ordinary patio/fence invoicing is untouched.
  isMakesafe: boolean;
  // Report-type card (portal report) vs physical make-safe (our crew report).
  isReportType: boolean;
  currentCycle: number;
  // A submitted/approved job_service_reports row for the current cycle.
  hasCurrentCycleReport: boolean;
  // A typed job_documents 'makesafe_report' row on the job.
  hasReportDoc: boolean;
};

// A physical make-safe is "report-in" when our report is filed for the current
// cycle (service report) or a typed report doc exists. Non-make-safe jobs and
// report-type cards are not this guard's concern -> always satisfied here.
export function reportInSatisfied(state: ReportInState): boolean {
  if (!state.isMakesafe) return true;
  if (state.isReportType) return true;
  return state.hasCurrentCycleReport || state.hasReportDoc;
}

// Does advancing to `nextSubstatus` on a PHYSICAL make-safe require report-in
// first? Only non-report make-safe cards moving to a report-complete substatus.
export function substatusAdvanceNeedsReportIn(
  nextSubstatus: string | null | undefined,
  state: Pick<ReportInState, "isMakesafe" | "isReportType">,
): boolean {
  if (!state.isMakesafe || state.isReportType) return false;
  return (PORTAL_GUARDED_ADVANCE_SUBSTATUSES as readonly string[]).includes(
    String(nextSubstatus || ""),
  );
}

export type ExternalLinkLike =
  | string
  | {
    url?: unknown;
    href?: unknown;
    link?: unknown;
    label?: unknown;
    kind?: unknown;
  };

export type CaptureLink = { url: string; label: string; role: string };

const REPORT_LINK_KINDS = new Set([
  "roof_report",
  "assessment_report",
  "photos",
  "quote",
  "builder_portal",
]);

// The report-portal links on a card, shaped for capture_portal_evidence.py's
// links.json ({ref,url,role,label}). A link counts as a portal link when its kind
// is a known report kind OR its URL is a builder-portal/share link. Deduped by URL.
export function extractPortalLinks(externalLinks: unknown): CaptureLink[] {
  const arr = Array.isArray(externalLinks)
    ? externalLinks
    : (externalLinks == null ? [] : [externalLinks]);
  const out: CaptureLink[] = [];
  const seen = new Set<string>();
  for (const raw of arr as ExternalLinkLike[]) {
    let url = "";
    let label = "Builder portal";
    let kind = "builder_portal";
    if (typeof raw === "string") {
      url = raw.trim();
    } else if (raw && typeof raw === "object") {
      url = String(raw.url ?? raw.href ?? raw.link ?? "").trim();
      if (typeof raw.label === "string" && raw.label.trim()) {
        label = raw.label.trim();
      }
      if (typeof raw.kind === "string" && raw.kind.trim()) {
        kind = raw.kind.trim();
      }
    }
    if (!url) continue;
    const isPortal = REPORT_LINK_KINDS.has(kind) || urlIsBuilderPortalLink(url);
    if (!isPortal) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url, label, role: kind });
  }
  return out;
}

// Terminal job statuses that are never eligible for a portal re-check.
const RECHECK_DEAD_STATUSES = new Set([
  "cancelled",
  "archived",
  "lost",
  "deleted",
  "void",
  "voided",
  "duplicate",
  "duplicated",
]);

export type PortalRecheckCard = {
  jobStatus: string | null | undefined;
  isReportType: boolean;
  externalLinks: unknown;
  currentCycle: number;
  verifiedAt: string | null;
  verifiedCycle: number | null;
};

// Should this card be in the portal-recheck queue an agent run consumes? A card
// is eligible when it is a report-type card on an active job that carries at least
// one portal link and is NOT verified for its current cycle. Deliberately NOT
// substatus-filtered: a "graf" card sitting at ready_to_invoice UNVERIFIED is the
// prime case that needs a re-check, right alongside a card still waiting on the
// trade — both are unverified report-type cards with a portal to check.
export function portalRecheckEligible(card: PortalRecheckCard): boolean {
  if (!card.isReportType) return false;
  if (RECHECK_DEAD_STATUSES.has(String(card.jobStatus || "").toLowerCase())) {
    return false;
  }
  if (
    portalVerificationSatisfied({
      isReportType: true,
      currentCycle: card.currentCycle,
      verifiedAt: card.verifiedAt,
      verifiedCycle: card.verifiedCycle,
    })
  ) return false; // already verified this cycle
  return extractPortalLinks(card.externalLinks).length > 0;
}

// Rate limit for the enqueue cron: stamp a card only if it has never been enqueued
// or was last enqueued longer ago than the cadence window. Idempotent within window.
export function portalRecheckDue(
  requestedAt: string | null | undefined,
  now: number,
  minIntervalMs: number,
): boolean {
  if (!requestedAt) return true;
  const last = Date.parse(requestedAt);
  if (!Number.isFinite(last)) return true;
  return now - last >= minIntervalMs;
}
