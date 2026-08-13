import {
  canonicalSesPortalCaptureResult,
  canonicalSesPortalCaptureRole,
  canonicalSesPortalSourceUrl,
  SES_PORTAL_CAPTURE_PRODUCER,
} from "./ses_portal_capture_contract.ts";

export interface PrimeCaptureSweepCard {
  job_id: string;
  job_number: string | null;
  report_type: string;
  portal_links: Array<{
    role: string;
    url: string;
    label?: string | null;
  }>;
}

export interface PrimeCaptureSweepRevision {
  id: string;
  job_id: string;
  attendance_cycle_id: string;
  role: string;
  capture_result: string;
  source_url: string;
  capture_producer: string;
  captured_at: string;
  signal: string;
  makesafe_fact_version: number;
}

function token(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function isPrimeCaptureShareUrl(value: unknown): boolean {
  const canonical = canonicalSesPortalSourceUrl(value);
  if (!canonical) return false;
  const parsed = new URL(canonical);
  const primeHost = parsed.hostname === "primeeco.tech" ||
    parsed.hostname.endsWith(".primeeco.tech");
  return primeHost && /^\/(?:share|report)\//i.test(parsed.pathname);
}

export function primeCaptureSweepRole(
  reportType: unknown,
  rawRole: unknown,
): "roof_report" | "assessment" | "photos" | "scope" | null {
  const canonical = canonicalSesPortalCaptureRole(rawRole);
  if (canonical) return canonical;
  if (
    token(rawRole) === "builderportal" &&
    ["roofreport", "ordinaryroofportal", "owntemplateroof"].includes(
      token(reportType),
    )
  ) {
    return "roof_report";
  }
  return null;
}

function compareRevisions(
  a: PrimeCaptureSweepRevision,
  b: PrimeCaptureSweepRevision,
): number {
  return Number(b.makesafe_fact_version || 0) -
      Number(a.makesafe_fact_version || 0) ||
    String(b.captured_at || "").localeCompare(String(a.captured_at || ""));
}

/**
 * Privacy-small reader feed for the browser sweep. It publishes only the
 * canonical Prime identity plus prior deterministic observations needed to
 * decide whether this run is a no-op. Canonical builder reference and current
 * cycle still come from U4 immediately before every record write.
 */
export function buildPrimeCaptureSweepItems(
  cards: PrimeCaptureSweepCard[],
  revisions: PrimeCaptureSweepRevision[],
): Array<Record<string, unknown>> {
  const revisionsByIdentity = new Map<string, PrimeCaptureSweepRevision[]>();
  for (const revision of revisions) {
    if (revision.capture_producer !== SES_PORTAL_CAPTURE_PRODUCER) continue;
    const role = canonicalSesPortalCaptureRole(revision.role);
    const url = canonicalSesPortalSourceUrl(revision.source_url);
    const result = canonicalSesPortalCaptureResult(revision.capture_result);
    if (
      !revision.job_id || !revision.attendance_cycle_id || !role || !url ||
      !result
    ) {
      continue;
    }
    const key = `${revision.job_id}\n${role}\n${url}`;
    const rows = revisionsByIdentity.get(key) || [];
    rows.push({ ...revision, role, source_url: url, capture_result: result });
    revisionsByIdentity.set(key, rows);
  }
  for (const rows of revisionsByIdentity.values()) rows.sort(compareRevisions);

  const items: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const card of cards) {
    const reportType = token(card.report_type);
    if (
      ![
        "roofreport",
        "ordinaryroofportal",
        "owntemplateroof",
        "assessmentreport",
        "assessmentreportquote",
        "assessmentquote",
      ]
        .includes(reportType)
    ) {
      continue;
    }
    for (const link of card.portal_links || []) {
      const role = primeCaptureSweepRole(card.report_type, link.role);
      const url = canonicalSesPortalSourceUrl(link.url);
      if (!role || !url || !isPrimeCaptureShareUrl(url)) continue;
      const key = `${card.job_id}\n${role}\n${url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        job_id: card.job_id,
        job_number: card.job_number,
        report_type: card.report_type,
        role,
        source_url: url,
        label: link.label || null,
        revisions: revisionsByIdentity.get(key) || [],
      });
    }
  }
  return items.sort((a, b) =>
    String(a.job_number || a.job_id).localeCompare(
      String(b.job_number || b.job_id),
    ) || String(a.role).localeCompare(String(b.role))
  );
}
