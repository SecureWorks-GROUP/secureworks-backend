// deno-lint-ignore-file no-explicit-any
// ════════════════════════════════════════════════════════════
// MAKE-SAFE INTAKE RECONCILIATION SNAPSHOT
// Mission: makesafe-intake-reliability-hardening-2026-06-24
// ════════════════════════════════════════════════════════════
//
// Read-only operator view: every recent source email should be visibly accounted
// for by a draft/job, or surfaced as an explicit risk/skipped/stuck reason. This
// complements the existing D1/D2 email reconciliation by focusing on the intake
// queue itself (emails -> intake drafts -> live jobs) and avoids any send/Xero/job
// mutation.

import {
  normaliseCompany,
  normaliseJobFamily,
  normaliseRef,
} from "./makesafe_intake_dedup.ts";
import {
  isPureAckNoAction,
  subjectIsExcludedNonWorkOrder,
  subjectLooksLikeNewWorkOrder,
  subjectMatchesReportCapture,
} from "./makesafe_intake_gate.ts";
import { isOwnDomain } from "./makesafe_compact_reads.ts";
import { senderMatchesPattern } from "../_shared/makesafe_intake_classification.ts";

export interface IntakeReconEmail {
  post_id?: string | null;
  subject?: string | null;
  from_email?: string | null;
  received_at?: string | null;
  has_attachments?: boolean | null;
}

export interface IntakeReconDraft {
  id?: string | null;
  graph_message_id?: string | null;
  internet_message_id?: string | null;
  external_ref?: string | null;
  requesting_company_slug?: string | null;
  requesting_company_name?: string | null;
  status?: string | null;
  report_type?: string | null;
  subject?: string | null;
  received_at?: string | null;
  created_at?: string | null;
  confidence?: string | null;
  missing_fields?: string[] | null;
  extraction_json?: any;
  attachments_json?: any;
}

export interface IntakeReconJob {
  job_id?: string | null;
  external_ref?: string | null;
  requesting_company_slug?: string | null;
  requesting_company_name?: string | null;
  report_type?: string | null;
  jobs?: any;
}

export interface IntakeReconItem {
  kind: "source_email" | "draft" | "job";
  state:
    | "visible_draft"
    | "visible_job"
    | "visible_skip"
    | "stuck_review"
    | "unmatched_source";
  reason: string;
  source_email_id?: string | null;
  draft_id?: string | null;
  job_id?: string | null;
  external_ref?: string | null;
  requesting_company?: string | null;
  makesafe_job_family?: string | null;
  received_at?: string | null;
  age_minutes?: number | null;
}

export interface IntakeReconAlertItem {
  kind: "draft" | "job";
  reason:
    | "attachment_extraction_failure"
    | "duplicate_suppression"
    | "model_uncertainty"
    | "no_family";
  id: string | null;
  external_ref?: string | null;
  requesting_company?: string | null;
  detail: string;
}

export interface IntakeReconSummary {
  ok: true;
  window_days: number;
  stale_minutes: number;
  counts: {
    source_emails_found: number;
    drafts_visible: number;
    jobs_visible: number;
    visible_skip_reasons: number;
    unmatched_source_emails: number;
    stuck_items: number;
    alert_items: number;
  };
  items: IntakeReconItem[];
  alert_items: IntakeReconAlertItem[];
}

function jobRow(job: IntakeReconJob): any {
  return Array.isArray(job.jobs) ? job.jobs[0] : job.jobs;
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

function parseArr(value: any): any[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }
  return [];
}

function familyFromDraft(draft: IntakeReconDraft): string {
  const extraction = parseObj(draft.extraction_json);
  return normaliseJobFamily(
    extraction.makesafe_job_family || extraction.job_family ||
      draft.report_type,
  );
}

function familyFromJob(job: IntakeReconJob): string {
  const metadata = parseObj(jobRow(job)?.metadata);
  return normaliseJobFamily(metadata.makesafe_job_family || job.report_type);
}

function refCompany(
  ref: string | null | undefined,
  slug: string | null | undefined,
  name: string | null | undefined,
): string {
  const r = normaliseRef(ref);
  const c = normaliseCompany(slug, name);
  return r && c ? `${r}|${c}` : "";
}

function refCompanyFamily(
  ref: string | null | undefined,
  slug: string | null | undefined,
  name: string | null | undefined,
  family: string | null | undefined,
): string {
  const rc = refCompany(ref, slug, name);
  const f = normaliseJobFamily(family);
  return rc && f ? `${rc}|${f}` : "";
}

function minutesOld(
  ts: string | null | undefined,
  nowMs: number,
): number | null {
  if (!ts) return null;
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 60_000));
}

function companyLabel(
  slug?: string | null,
  name?: string | null,
): string | null {
  return (slug || name || "").trim() || null;
}

function skipReason(draft: IntakeReconDraft): string | null {
  const status = String(draft.status || "").toLowerCase();
  if (status !== "rejected" && status !== "superseded") return null;
  const extraction = parseObj(draft.extraction_json);
  const reason = extraction.rejection_reason || extraction.skip_reason ||
    extraction.classification_reason;
  return String(reason || status).trim();
}

export function summarizeMakesafeIntakeReconciliation(input: {
  emails: IntakeReconEmail[];
  drafts: IntakeReconDraft[];
  jobs: IntakeReconJob[];
  nowIso?: string;
  windowDays?: number;
  staleMinutes?: number;
  limitItems?: number;
}): IntakeReconSummary {
  const nowMs = input.nowIso ? Date.parse(input.nowIso) : Date.now();
  const staleMinutes = input.staleMinutes ?? 10;
  const limitItems = input.limitItems ?? 200;
  const items: IntakeReconItem[] = [];
  const alertItems: IntakeReconAlertItem[] = [];

  const draftsByEmail = new Map<string, IntakeReconDraft[]>();
  for (const d of input.drafts || []) {
    if (!d.graph_message_id) continue;
    const arr = draftsByEmail.get(d.graph_message_id) || [];
    arr.push(d);
    draftsByEmail.set(d.graph_message_id, arr);
  }

  const jobsByRcf = new Map<string, IntakeReconJob[]>();
  const jobsByRc = new Map<string, IntakeReconJob[]>();
  for (const j of input.jobs || []) {
    const rc = refCompany(
      j.external_ref,
      j.requesting_company_slug,
      j.requesting_company_name,
    );
    const rcf = refCompanyFamily(
      j.external_ref,
      j.requesting_company_slug,
      j.requesting_company_name,
      familyFromJob(j),
    );
    if (rc) jobsByRc.set(rc, [...(jobsByRc.get(rc) || []), j]);
    if (rcf) jobsByRcf.set(rcf, [...(jobsByRcf.get(rcf) || []), j]);
  }

  let visibleSkipReasons = 0;
  let stuckItems = 0;
  let unmatched = 0;

  for (const d of input.drafts || []) {
    const draftFamily = familyFromDraft(d);
    const missingFields = Array.isArray(d.missing_fields)
      ? d.missing_fields.map((f) => String(f || "").trim()).filter(Boolean)
      : [];
    const confidence = String(d.confidence || "").trim().toLowerCase();
    const company = companyLabel(
      d.requesting_company_slug,
      d.requesting_company_name,
    );
    if (!draftFamily) {
      alertItems.push({
        kind: "draft",
        reason: "no_family",
        id: d.id || null,
        external_ref: d.external_ref || null,
        requesting_company: company,
        detail: "draft_missing_makesafe_job_family",
      });
    }
    if (
      (confidence && confidence !== "high") ||
      missingFields.includes("ai_not_a_work_order_needs_review") ||
      missingFields.includes("unknown_family_needs_review") ||
      missingFields.includes("job_unknown_family_needs_review")
    ) {
      alertItems.push({
        kind: "draft",
        reason: "model_uncertainty",
        id: d.id || null,
        external_ref: d.external_ref || null,
        requesting_company: company,
        detail: `confidence_${confidence || "unknown"}${
          missingFields.length ? ":" + missingFields.join(",") : ""
        }`,
      });
    }
    const attachmentFailures = parseArr(d.attachments_json).filter((a) =>
      a?.pdf_unavailable || a?.pdf_error
    );
    for (const att of attachmentFailures) {
      alertItems.push({
        kind: "draft",
        reason: "attachment_extraction_failure",
        id: d.id || null,
        external_ref: d.external_ref || null,
        requesting_company: company,
        detail: String(att?.pdf_error || "pdf_unavailable").slice(0, 200),
      });
    }

    const reason = skipReason(d);
    if (reason) {
      if (/duplicat|suppress/i.test(reason)) {
        alertItems.push({
          kind: "draft",
          reason: "duplicate_suppression",
          id: d.id || null,
          external_ref: d.external_ref || null,
          requesting_company: company,
          detail: reason,
        });
      }
      visibleSkipReasons++;
      items.push({
        kind: "draft",
        state: "visible_skip",
        reason,
        source_email_id: d.graph_message_id || d.internet_message_id || null,
        draft_id: d.id || null,
        external_ref: d.external_ref || null,
        requesting_company: company,
        makesafe_job_family: draftFamily || null,
        received_at: d.received_at || d.created_at || null,
        age_minutes: minutesOld(d.received_at || d.created_at, nowMs),
      });
      continue;
    }

    const status = String(d.status || "").toLowerCase();
    const age = minutesOld(d.received_at || d.created_at, nowMs);
    if (
      (status === "draft" || status === "needs_review" ||
        status === "reopen_candidate") && age != null && age >= staleMinutes
    ) {
      stuckItems++;
      items.push({
        kind: "draft",
        state: "stuck_review",
        reason: `draft_status_${
          status || "unknown"
        }_older_than_${staleMinutes}m`,
        source_email_id: d.graph_message_id || d.internet_message_id || null,
        draft_id: d.id || null,
        external_ref: d.external_ref || null,
        requesting_company: company,
        makesafe_job_family: draftFamily || null,
        received_at: d.received_at || d.created_at || null,
        age_minutes: age,
      });
    }
  }

  for (const j of input.jobs || []) {
    const family = familyFromJob(j);
    if (!family) {
      alertItems.push({
        kind: "job",
        reason: "no_family",
        id: j.job_id || null,
        external_ref: j.external_ref || null,
        requesting_company: companyLabel(
          j.requesting_company_slug,
          j.requesting_company_name,
        ),
        detail: "job_missing_makesafe_job_family",
      });
    }
  }

  for (const e of input.emails || []) {
    const emailId = e.post_id || null;
    const linkedDrafts = emailId ? draftsByEmail.get(emailId) || [] : [];
    if (linkedDrafts.length) {
      const d = linkedDrafts[0];
      const family = familyFromDraft(d);
      const rcf = refCompanyFamily(
        d.external_ref,
        d.requesting_company_slug,
        d.requesting_company_name,
        family,
      );
      const rc = refCompany(
        d.external_ref,
        d.requesting_company_slug,
        d.requesting_company_name,
      );
      const job = (rcf && jobsByRcf.get(rcf)?.[0]) ||
        (rc && jobsByRc.get(rc)?.[0]) || null;
      items.push({
        kind: job ? "job" : "draft",
        state: job ? "visible_job" : "visible_draft",
        reason: job
          ? "source_email_has_live_job"
          : `source_email_has_${d.status || "draft"}_draft`,
        source_email_id: emailId,
        draft_id: d.id || null,
        job_id: job?.job_id || null,
        external_ref: d.external_ref || job?.external_ref || null,
        requesting_company:
          companyLabel(d.requesting_company_slug, d.requesting_company_name) ||
          companyLabel(
            job?.requesting_company_slug,
            job?.requesting_company_name,
          ),
        makesafe_job_family: family || familyFromJob(job || {}) || null,
        received_at: e.received_at || d.received_at || null,
        age_minutes: minutesOld(e.received_at || d.received_at, nowMs),
      });
    } else {
      unmatched++;
      items.push({
        kind: "source_email",
        state: "unmatched_source",
        reason: "source_email_has_no_visible_draft_or_job_match",
        source_email_id: emailId,
        received_at: e.received_at || null,
        age_minutes: minutesOld(e.received_at, nowMs),
      });
    }
  }

  const uniqueJobs = new Set(
    (input.jobs || []).map((j) => j.job_id).filter(Boolean),
  );
  return {
    ok: true,
    window_days: input.windowDays ?? 7,
    stale_minutes: staleMinutes,
    counts: {
      source_emails_found: (input.emails || []).length,
      drafts_visible:
        (input.drafts || []).filter((d) =>
          ["draft", "needs_review", "approved", "reopen_candidate"].includes(
            String(d.status || "").toLowerCase(),
          )
        ).length,
      jobs_visible: uniqueJobs.size,
      visible_skip_reasons: visibleSkipReasons,
      unmatched_source_emails: unmatched,
      stuck_items: stuckItems,
      alert_items: alertItems.length,
    },
    items: items.slice(0, limitItems),
    alert_items: alertItems.slice(0, limitItems),
  };
}

export async function makesafeIntakeReconciliation(
  client: any,
  opts: {
    nowIso?: string;
    windowDays?: number;
    staleMinutes?: number;
    limitItems?: number;
  } = {},
): Promise<IntakeReconSummary> {
  const windowDays = opts.windowDays ?? 7;
  const nowMs = opts.nowIso ? Date.parse(opts.nowIso) : Date.now();
  const sinceIso = new Date(nowMs - windowDays * 86_400_000).toISOString();

  const [emailsRes, draftsRes, jobsRes] = await Promise.all([
    client.from("emails")
      .select("post_id, subject, from_email, received_at, has_attachments")
      .eq("mailbox", "ses@secureworkswa.com.au")
      .is("pii_purged_at", null)
      .gte("received_at", sinceIso)
      .order("received_at", { ascending: false })
      .limit(500),
    client.from("makesafe_intake_drafts")
      .select(
        "id, graph_message_id, internet_message_id, external_ref, requesting_company_slug, requesting_company_name, status, report_type, subject, received_at, created_at, confidence, missing_fields, extraction_json, attachments_json",
      )
      .gte("received_at", sinceIso)
      .order("received_at", { ascending: false })
      .limit(500),
    client.from("makesafe_job_details")
      .select(
        "job_id, external_ref, requesting_company_slug, requesting_company_name, report_type, jobs(status, job_number, created_at, metadata)",
      )
      .not("external_ref", "is", null)
      .limit(1000),
  ]);

  if (emailsRes.error) {
    throw new Error(
      `emails read failed: ${emailsRes.error.message ?? emailsRes.error}`,
    );
  }
  if (draftsRes.error) {
    throw new Error(
      `intake drafts read failed: ${
        draftsRes.error.message ?? draftsRes.error
      }`,
    );
  }
  if (jobsRes.error) {
    throw new Error(
      `makesafe jobs read failed: ${jobsRes.error.message ?? jobsRes.error}`,
    );
  }

  return summarizeMakesafeIntakeReconciliation({
    emails: emailsRes.data || [],
    drafts: draftsRes.data || [],
    jobs: jobsRes.data || [],
    nowIso: opts.nowIso,
    windowDays,
    staleMinutes: opts.staleMinutes,
    limitItems: opts.limitItems,
  });
}

// ════════════════════════════════════════════════════════════
// D-e — THE AUDIT INVARIANT ("did we miss anything")
// ════════════════════════════════════════════════════════════
// The strict one-line invariant the Captain asked for: every source email in the
// window is ACCOUNTED FOR — a linked draft (any status), OR a live job already on
// its ref (dedup would skip it), OR a deterministic non-work-order classification
// with a reason (own outbound, excluded subject, pure ack, or not a make-safe
// candidate at all). Anything left is a genuine inbound make-safe candidate with no
// draft and no job. ZERO unaccounted = the board is live and true. This reuses the
// SAME gate helpers the scan uses, so the accounting matches what the scan would do.

export interface IntakeReconcileInvariantItem {
  post_id: string | null;
  subject: string | null;
  from_email: string | null;
  received_at: string | null;
  age_minutes: number | null;
  state: "accounted" | "unaccounted";
  reason: string;
}

export interface IntakeReconcileInvariant {
  ok: true;
  window_days: number;
  generated_at: string;
  live_and_true: boolean;
  counts: {
    source_emails: number;
    accounted: number;
    unaccounted: number;
  };
  unaccounted: IntakeReconcileInvariantItem[];
}

export function summarizeIntakeReconcileInvariant(input: {
  emails: IntakeReconEmail[];
  drafts: IntakeReconDraft[];
  jobs: IntakeReconJob[];
  senderPatterns?: string[];
  nowIso?: string;
  windowDays?: number;
  limitUnaccounted?: number;
}): IntakeReconcileInvariant {
  const nowMs = input.nowIso ? Date.parse(input.nowIso) : Date.now();
  const windowDays = input.windowDays ?? 7;
  const limit = input.limitUnaccounted ?? 200;
  const senderPatterns = (input.senderPatterns || [])
    .map((p) => String(p || "").toLowerCase())
    .filter(Boolean);

  // Linkage: a draft's graph_message_id equals the source email post_id.
  const draftedPostIds = new Set<string>();
  for (const d of input.drafts || []) {
    if (d.graph_message_id) draftedPostIds.add(d.graph_message_id);
  }
  const jobRefs: string[] = [];
  for (const j of input.jobs || []) {
    const nr = normaliseRef(j.external_ref);
    if (nr.length >= 5) jobRefs.push(nr);
  }

  const unaccounted: IntakeReconcileInvariantItem[] = [];
  let accounted = 0;

  for (const e of input.emails || []) {
    const postId = e.post_id || null;
    const subject = e.subject || "";
    const fromEmail = e.from_email || "";

    // 1) linked draft (any status)
    if (postId && draftedPostIds.has(postId)) {
      accounted++;
      continue;
    }
    // 2) our own outbound copy — never an inbound intake candidate
    const at = fromEmail.lastIndexOf("@");
    const domain = at >= 0 ? fromEmail.slice(at + 1).trim().toLowerCase() : null;
    if (isOwnDomain(domain)) {
      accounted++;
      continue;
    }
    // 3) gate-excluded non-work-order subject (photo evidence / report / invoice / …)
    if (subjectIsExcludedNonWorkOrder(subject)) {
      accounted++;
      continue;
    }
    // 4) pure acknowledgement (thanks/noted, no action, no attachment)
    if (isPureAckNoAction(subject, !!e.has_attachments)) {
      accounted++;
      continue;
    }
    // 5) not a make-safe candidate at all — the scan's matchedMessages filter would
    //    never draft it (unknown sender AND no WO/report subject on a builder-ish domain).
    const senderMatch = senderPatterns.some((p) =>
      senderMatchesPattern(fromEmail, p)
    );
    const woSubject = subjectLooksLikeNewWorkOrder(subject) ||
      subjectMatchesReportCapture(subject) ||
      /work\s*order|make\s*safe|emergency|storm|urgent\s*(attend|repair)/i.test(
        subject,
      );
    const builderish = fromEmail.includes(".build") ||
      fromEmail.includes("primeeco.tech");
    if (!(senderMatch || (woSubject && builderish))) {
      accounted++;
      continue;
    }
    // 6) candidate with no draft: is a live job already on a ref named in the subject?
    const normSubject = normaliseRef(subject);
    if (jobRefs.some((r) => normSubject.includes(r))) {
      accounted++;
      continue;
    }
    // 7) a real inbound make-safe candidate with NO draft and NO job — UNACCOUNTED.
    unaccounted.push({
      post_id: postId,
      subject: e.subject || null,
      from_email: e.from_email || null,
      received_at: e.received_at || null,
      age_minutes: minutesOld(e.received_at, nowMs),
      state: "unaccounted",
      reason: "make_safe_candidate_no_draft_no_job",
    });
  }

  return {
    ok: true,
    window_days: windowDays,
    generated_at: new Date(nowMs).toISOString(),
    live_and_true: unaccounted.length === 0,
    counts: {
      source_emails: (input.emails || []).length,
      accounted,
      unaccounted: unaccounted.length,
    },
    unaccounted: unaccounted.slice(0, limit),
  };
}

export async function makesafeIntakeReconcileInvariant(
  client: any,
  opts: { nowIso?: string; windowDays?: number; limitUnaccounted?: number } = {},
): Promise<IntakeReconcileInvariant> {
  const windowDays = opts.windowDays ?? 7;
  const nowMs = opts.nowIso ? Date.parse(opts.nowIso) : Date.now();
  const sinceIso = new Date(nowMs - windowDays * 86_400_000).toISOString();

  const [emailsRes, draftsRes, jobsRes, companiesRes] = await Promise.all([
    client.from("emails")
      .select("post_id, subject, from_email, received_at, has_attachments")
      .eq("mailbox", "ses@secureworkswa.com.au")
      .is("pii_purged_at", null)
      .gte("received_at", sinceIso)
      .order("received_at", { ascending: false })
      .limit(1000),
    client.from("makesafe_intake_drafts")
      .select("graph_message_id, status, received_at, created_at")
      .gte("received_at", sinceIso)
      .limit(1000),
    client.from("makesafe_job_details")
      .select("external_ref")
      .not("external_ref", "is", null)
      .limit(2000),
    client.from("makesafe_companies")
      .select("sender_patterns")
      .eq("active", true),
  ]);

  if (emailsRes.error) {
    throw new Error(
      `emails read failed: ${emailsRes.error.message ?? emailsRes.error}`,
    );
  }
  if (draftsRes.error) {
    throw new Error(
      `intake drafts read failed: ${draftsRes.error.message ?? draftsRes.error}`,
    );
  }
  if (jobsRes.error) {
    throw new Error(
      `makesafe jobs read failed: ${jobsRes.error.message ?? jobsRes.error}`,
    );
  }

  const senderPatterns: string[] = [];
  for (const co of (companiesRes.data || [])) {
    for (const p of (co.sender_patterns || [])) {
      if (p) senderPatterns.push(String(p).toLowerCase());
    }
  }

  return summarizeIntakeReconcileInvariant({
    emails: emailsRes.data || [],
    drafts: draftsRes.data || [],
    jobs: jobsRes.data || [],
    senderPatterns,
    nowIso: opts.nowIso,
    windowDays,
    limitUnaccounted: opts.limitUnaccounted,
  });
}
