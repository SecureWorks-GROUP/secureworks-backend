// deno-lint-ignore-file no-explicit-any
// ════════════════════════════════════════════════════════════
// MAKE-SAFE INTAKE FAMILY BACKFILL REPORT (READ-ONLY)
// Mission: makesafe-intake-reliability-hardening-2026-06-24
// ════════════════════════════════════════════════════════════
//
// Dry-run only: identify legacy draft/job rows whose practical make-safe job
// family can be safely inferred from existing extraction_json, job metadata,
// report_type, subject/body/description, and surface unknown-family rows that can
// suppress same-ref variants until a human backfills or reviews them. No data is
// mutated here; callers get a candidate/risk report they can use before any live
// migration/backfill.

import {
  classifyMakeSafeJobFamily,
  type MakeSafeJobFamily,
} from "./makesafe_intake_gate.ts";
import {
  normaliseCompany,
  normaliseJobFamily,
  normaliseRef,
} from "./makesafe_intake_dedup.ts";

const FAMILY_VALUES = new Set<string>([
  "assessment_report_quote",
  "roof_report",
  "temp_fence_makesafe",
  "general_makesafe",
]);

const LIVE_OR_SUPPRESSING_STATES = new Set([
  "draft",
  "needs_review",
  "approved",
  "reopen_candidate",
  "rejected",
  "superseded",
]);

export interface BackfillDraftRow {
  id?: string | null;
  external_ref?: string | null;
  requesting_company_slug?: string | null;
  requesting_company_name?: string | null;
  status?: string | null;
  report_type?: string | null;
  subject?: string | null;
  body_preview?: string | null;
  description?: string | null;
  extraction_json?: any;
  received_at?: string | null;
  created_at?: string | null;
}

export interface BackfillJobRow {
  job_id?: string | null;
  external_ref?: string | null;
  requesting_company_slug?: string | null;
  requesting_company_name?: string | null;
  report_type?: string | null;
  jobs?: any;
}

export interface BackfillReportItem {
  kind: "draft" | "job";
  state:
    | "backfill_candidate"
    | "review_required"
    | "unknown_family_suppression_risk"
    // M-G FIX 2 — the stored family disagrees with the negation-aware classifier re-run
    // over the WO text. Flag-only: a human retypes via the existing gated path; never mutated.
    | "family_mismatch_review";
  reason: string;
  id: string | null;
  external_ref: string | null;
  requesting_company: string | null;
  current_family: string | null;
  inferred_family: MakeSafeJobFamily | null;
  confidence: "explicit" | "report_type" | "text" | "none";
  status?: string | null;
}

export interface BackfillReportSummary {
  ok: true;
  dry_run: true;
  limit_items: number;
  counts: {
    drafts_examined: number;
    jobs_examined: number;
    backfill_candidates: number;
    review_required: number;
    unknown_family_suppression_risks: number;
    family_mismatch_reviews: number;
  };
  items: BackfillReportItem[];
}

function parseObj(value: any): Record<string, any> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch (_) {
      return {};
    }
  }
  return {};
}

function jobRow(job: BackfillJobRow): any {
  return Array.isArray(job.jobs) ? job.jobs[0] : job.jobs;
}

function cleanFamily(
  value: string | null | undefined,
): MakeSafeJobFamily | null {
  const f = normaliseJobFamily(value);
  return FAMILY_VALUES.has(f) ? f as MakeSafeJobFamily : null;
}

function familyFromReportType(
  reportType: string | null | undefined,
): MakeSafeJobFamily | null {
  const rt = String(reportType || "").trim().toLowerCase();
  if (rt === "temp_fence" || rt === "temp_fence_makesafe") {
    return "temp_fence_makesafe";
  }
  if (rt === "roof_report") return "roof_report";
  if (rt === "assessment_report" || rt === "assessment_report_quote") {
    return "assessment_report_quote";
  }
  if (rt === "general_makesafe" || rt === "make_safe" || rt === "makesafe") {
    return "general_makesafe";
  }
  return null;
}

function hasGeneralMakeSafeSignal(text: string): boolean {
  return /\b(make\s*safe|makesafe|work\s*order|new\s*work\s*order|emergency|storm\s*(attend|repair)|urgent\s*(attend|repair))\b/i
    .test(text);
}

function inferSafeFamily(input: {
  explicitFamily?: string | null;
  reportType?: string | null;
  subject?: string | null;
  body?: string | null;
}): {
  family: MakeSafeJobFamily | null;
  confidence: "explicit" | "report_type" | "text" | "none";
} {
  const explicit = cleanFamily(input.explicitFamily);
  if (explicit) return { family: explicit, confidence: "explicit" };

  const byReportType = familyFromReportType(input.reportType);
  if (byReportType) return { family: byReportType, confidence: "report_type" };

  const text = `${input.subject || ""}\n${input.body || ""}`;
  if (!text.trim()) return { family: null, confidence: "none" };
  const classified = classifyMakeSafeJobFamily(
    input.subject || null,
    input.body || null,
    null,
  );
  if (classified !== "general_makesafe" || hasGeneralMakeSafeSignal(text)) {
    return { family: classified, confidence: "text" };
  }
  return { family: null, confidence: "none" };
}

// M-G FIX 2 drift signal — the NEGATION-AWARE classifier over the freshest WO TEXT ONLY
// (subject/body), never the co-set makesafe_type / report_type (those are set from the same
// body at intake and so agree with a wrong stored family - the v1 no-op). Returns a family
// only at `text` confidence (a non-general classification, or general with a real make-safe
// signal); null when the text has no usable signal. Comparing this to the stored family is
// the drift the flag surfaces.
function textInferredFamily(
  subject: string | null | undefined,
  body: string | null | undefined,
): MakeSafeJobFamily | null {
  const text = `${subject || ""}\n${body || ""}`;
  if (!text.trim()) return null;
  const classified = classifyMakeSafeJobFamily(subject || null, body || null, null);
  if (classified !== "general_makesafe" || hasGeneralMakeSafeSignal(text)) {
    return classified;
  }
  return null;
}

function refCompanyKey(
  ref: string | null | undefined,
  slug: string | null | undefined,
  name: string | null | undefined,
): string {
  const r = normaliseRef(ref);
  const c = normaliseCompany(slug, name);
  return r && c ? `${r}|${c}` : "";
}

function companyLabel(
  slug?: string | null,
  name?: string | null,
): string | null {
  return (slug || name || "").trim() || null;
}

function knownFamilyKeys(input: {
  drafts: BackfillDraftRow[];
  jobs: BackfillJobRow[];
}): Set<string> {
  const keys = new Set<string>();
  for (const d of input.drafts || []) {
    const extraction = parseObj(d.extraction_json);
    const current = cleanFamily(
      extraction.makesafe_job_family || extraction.job_family,
    );
    const rc = refCompanyKey(
      d.external_ref,
      d.requesting_company_slug,
      d.requesting_company_name,
    );
    if (rc && current) keys.add(`${rc}|${current}`);
  }
  for (const j of input.jobs || []) {
    const metadata = parseObj(jobRow(j)?.metadata);
    const current = cleanFamily(metadata.makesafe_job_family || j.report_type);
    const rc = refCompanyKey(
      j.external_ref,
      j.requesting_company_slug,
      j.requesting_company_name,
    );
    if (rc && current) keys.add(`${rc}|${current}`);
  }
  return keys;
}

export function summarizeMakesafeIntakeBackfillReport(input: {
  drafts: BackfillDraftRow[];
  jobs: BackfillJobRow[];
  limitItems?: number;
}): BackfillReportSummary {
  const limitItems = input.limitItems ?? 200;
  const items: BackfillReportItem[] = [];
  const knownKeys = knownFamilyKeys(input);

  let backfillCandidates = 0;
  let reviewRequired = 0;
  let suppressionRisks = 0;
  let familyMismatchReviews = 0;

  for (const d of input.drafts || []) {
    const extraction = parseObj(d.extraction_json);
    const current = cleanFamily(
      extraction.makesafe_job_family || extraction.job_family,
    );
    const inferred = inferSafeFamily({
      explicitFamily: extraction.makesafe_job_family || extraction.job_family,
      reportType: d.report_type,
      subject: d.subject || d.external_ref || null,
      body: [d.body_preview, d.description, extraction.description].filter(
        Boolean,
      )
        .join("\n"),
    });
    const rc = refCompanyKey(
      d.external_ref,
      d.requesting_company_slug,
      d.requesting_company_name,
    );
    const status = String(d.status || "").toLowerCase();

    if (!current && inferred.family) {
      backfillCandidates++;
      items.push({
        kind: "draft",
        state: "backfill_candidate",
        reason: `safe_${inferred.confidence}_family_inference`,
        id: d.id || null,
        external_ref: d.external_ref || null,
        requesting_company: companyLabel(
          d.requesting_company_slug,
          d.requesting_company_name,
        ),
        current_family: null,
        inferred_family: inferred.family,
        confidence: inferred.confidence,
        status: d.status || null,
      });
      continue;
    }

    if (!current && rc && LIVE_OR_SUPPRESSING_STATES.has(status)) {
      const hasKnownVariant = [...FAMILY_VALUES].some((family) =>
        knownKeys.has(`${rc}|${family}`)
      );
      if (hasKnownVariant) {
        suppressionRisks++;
        items.push({
          kind: "draft",
          state: "unknown_family_suppression_risk",
          reason:
            "legacy_unknown_family_draft_shares_ref_company_with_known_family_variant",
          id: d.id || null,
          external_ref: d.external_ref || null,
          requesting_company: companyLabel(
            d.requesting_company_slug,
            d.requesting_company_name,
          ),
          current_family: null,
          inferred_family: null,
          confidence: "none",
          status: d.status || null,
        });
        continue;
      }
    }

    if (!current && rc) {
      reviewRequired++;
      items.push({
        kind: "draft",
        state: "review_required",
        reason: "missing_family_no_safe_backfill_signal",
        id: d.id || null,
        external_ref: d.external_ref || null,
        requesting_company: companyLabel(
          d.requesting_company_slug,
          d.requesting_company_name,
        ),
        current_family: null,
        inferred_family: null,
        confidence: "none",
        status: d.status || null,
      });
    }

    // M-G FIX 2 — DRIFT FLAG: a family IS set but the negation-aware classifier over the
    // WO text disagrees. Flag-only for a human to retype; never mutated here.
    if (current) {
      const drift = textInferredFamily(
        d.subject || d.external_ref || null,
        [d.body_preview, d.description, extraction.description].filter(Boolean)
          .join("\n"),
      );
      if (drift && drift !== current) {
        familyMismatchReviews++;
        items.push({
          kind: "draft",
          state: "family_mismatch_review",
          reason: "stored_family_disagrees_with_negation_aware_classifier_over_wo_text",
          id: d.id || null,
          external_ref: d.external_ref || null,
          requesting_company: companyLabel(
            d.requesting_company_slug,
            d.requesting_company_name,
          ),
          current_family: current,
          inferred_family: drift,
          confidence: "text",
          status: d.status || null,
        });
      }
    }
  }

  for (const j of input.jobs || []) {
    const row = jobRow(j);
    const metadata = parseObj(row?.metadata);
    const current = cleanFamily(metadata.makesafe_job_family || j.report_type);
    const inferred = inferSafeFamily({
      explicitFamily: metadata.makesafe_job_family,
      reportType: j.report_type,
      subject: j.external_ref || null,
      body: [metadata.description, metadata.builder_email_body_text, row?.notes]
        .filter(Boolean).join("\n"),
    });
    const rc = refCompanyKey(
      j.external_ref,
      j.requesting_company_slug,
      j.requesting_company_name,
    );
    if (!current && inferred.family) {
      backfillCandidates++;
      items.push({
        kind: "job",
        state: "backfill_candidate",
        reason: `safe_${inferred.confidence}_family_inference`,
        id: j.job_id || null,
        external_ref: j.external_ref || null,
        requesting_company: companyLabel(
          j.requesting_company_slug,
          j.requesting_company_name,
        ),
        current_family: null,
        inferred_family: inferred.family,
        confidence: inferred.confidence,
      });
    } else if (!current && rc) {
      reviewRequired++;
      items.push({
        kind: "job",
        state: "review_required",
        reason: "missing_family_no_safe_backfill_signal",
        id: j.job_id || null,
        external_ref: j.external_ref || null,
        requesting_company: companyLabel(
          j.requesting_company_slug,
          j.requesting_company_name,
        ),
        current_family: null,
        inferred_family: null,
        confidence: "none",
      });
    } else if (current) {
      // M-G FIX 2 — DRIFT FLAG on a live job: stored family disagrees with the
      // negation-aware classifier over the job's WO text. Flag-only (human retypes).
      const drift = textInferredFamily(
        j.external_ref || null,
        [metadata.description, metadata.builder_email_body_text, row?.notes]
          .filter(Boolean).join("\n"),
      );
      if (drift && drift !== current) {
        familyMismatchReviews++;
        items.push({
          kind: "job",
          state: "family_mismatch_review",
          reason: "stored_family_disagrees_with_negation_aware_classifier_over_wo_text",
          id: j.job_id || null,
          external_ref: j.external_ref || null,
          requesting_company: companyLabel(
            j.requesting_company_slug,
            j.requesting_company_name,
          ),
          current_family: current,
          inferred_family: drift,
          confidence: "text",
        });
      }
    }
  }

  return {
    ok: true,
    dry_run: true,
    limit_items: limitItems,
    counts: {
      drafts_examined: (input.drafts || []).length,
      jobs_examined: (input.jobs || []).length,
      backfill_candidates: backfillCandidates,
      review_required: reviewRequired,
      unknown_family_suppression_risks: suppressionRisks,
      family_mismatch_reviews: familyMismatchReviews,
    },
    items: items.slice(0, limitItems),
  };
}

export async function makesafeIntakeBackfillReport(
  client: any,
  opts: { limitItems?: number } = {},
): Promise<BackfillReportSummary> {
  const [draftsRes, jobsRes] = await Promise.all([
    client.from("makesafe_intake_drafts")
      .select(
        "id, external_ref, requesting_company_slug, requesting_company_name, status, report_type, subject, body_preview, description, extraction_json, received_at, created_at",
      )
      .not("external_ref", "is", null)
      .limit(1000),
    client.from("makesafe_job_details")
      .select(
        "job_id, external_ref, requesting_company_slug, requesting_company_name, report_type, jobs(status, notes, metadata)",
      )
      .not("external_ref", "is", null)
      .limit(1000),
  ]);

  if (draftsRes.error) {
    throw new Error(
      `intake drafts backfill read failed: ${
        draftsRes.error.message ?? draftsRes.error
      }`,
    );
  }
  if (jobsRes.error) {
    throw new Error(
      `makesafe jobs backfill read failed: ${
        jobsRes.error.message ?? jobsRes.error
      }`,
    );
  }

  return summarizeMakesafeIntakeBackfillReport({
    drafts: draftsRes.data || [],
    jobs: jobsRes.data || [],
    limitItems: opts.limitItems,
  });
}
