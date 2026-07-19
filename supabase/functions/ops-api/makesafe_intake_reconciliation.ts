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
  contentFingerprint,
  contentFingerprintChecks,
  normaliseCompany,
  normaliseJobFamily,
  normaliseRef,
  subjectJobNumber,
} from "./makesafe_intake_dedup.ts";
import {
  extractBuilderWorkOrderIdentity,
  hasAnyPoLabel,
  hasUnparseablePoLabel,
  matchBuilderRefText,
  PO_LABEL_PATTERN,
} from "./makesafe_builder_work_order_identity.ts";
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
  internet_message_id?: string | null;
  subject?: string | null;
  from_email?: string | null;
  body_preview?: string | null;
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
  from_email?: string | null;
  body_preview?: string | null;
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
// draft and no job. ZERO unaccounted = the board is live and true. Every source row
// is returned as matched, accounted alias/revision, or genuinely unaccounted with an
// evidence pointer. Raw refs remain intact beside separately canonicalised claim/PO
// identity. This reuses the SAME gate helpers the scan uses, so accounting matches
// what the scan would do.

export type IntakeReconcileClassification =
  | "matched"
  | "accounted_alias_revision"
  | "genuinely_unaccounted";

export interface IntakeReconcileEvidencePointer {
  kind: "draft" | "job" | "classification";
  id: string;
}

export interface IntakeReconcileInvariantItem {
  post_id: string | null;
  subject: string | null;
  from_email: string | null;
  received_at: string | null;
  age_minutes: number | null;
  state: "accounted" | "unaccounted";
  classification: IntakeReconcileClassification;
  reason: string;
  evidence: IntakeReconcileEvidencePointer;
  /** Raw source representation retained for operator audit. */
  raw_reference: string | null;
  canonical_claim_ref: string | null;
  canonical_po_ref: string | null;
}

export interface IntakeReconcileInvariant {
  ok: true;
  window_days: number;
  generated_at: string;
  live_and_true: boolean;
  counts: {
    source_emails: number;
    matched: number;
    accounted_alias_revision: number;
    accounted: number;
    genuinely_unaccounted: number;
    unaccounted: number;
  };
  /** One explicit classification per source row. */
  items: IntakeReconcileInvariantItem[];
  unaccounted: IntakeReconcileInvariantItem[];
}

interface ReconcileIdentity {
  claim: string;
  po: string;
  workOrder: string;
  raw: string | null;
  /**
   * Every normalised job-unique token this row can offer as a content-fingerprint
   * discriminator, richest first. A stored draft is enriched by its extraction_json
   * while a source only has its subject, so neither side can be relied on to produce
   * the SAME single token; both publish all of theirs and a twin needs one to align.
   * `raw` is label text ("Job No 12345") and is for operator display only — feeding it
   * to the fingerprint would make a source resolve to r:JOBNO12345 while the stored
   * draft resolves to r:12345.
   */
  canonicalRefs: string[];
  /**
   * Durable exact identity tokens used only when no canonical builder claim is
   * parseable — known refs whose prefix is outside the builder claim vocabulary and
   * the bare "Job No <NNNNN>" archetype. Namespaced so a job number can never
   * collide with a reference whose digits happen to match.
   */
  keys: string[];
  /**
   * The subject carries a PO label the canonical extractor cannot parse, so this row
   * may name a PO we cannot see. Treated as "PO unknown", never as "no PO": a
   * claim-only alias would collapse it onto another PO's lineage.
   */
  poUnparsed: boolean;
  /**
   * poUnparsed, or the body names a PO in any spelling. A quoted or footer PO is not
   * adopted as identity, but it does mean the authoritative fields may not show the
   * whole picture, so identity inference (claim and token matching) is withheld
   * unless both sides already name an explicit PO, which pins the deliverable.
   * Durable evidence — post id, internet message id, content fingerprint — is
   * unaffected, since none of it reasons about the PO.
   */
  poContextAmbiguous: boolean;
}

const JOB_NUMBER_TEXT_RE = /\bjob\s*(?:no\.?|number|#)\s*[:#-]?\s*\d{3,7}\b/i;
/**
 * Australian state abbreviation followed by a four digit postcode. Address text
 * shaped exactly like a reference token, so it must never become an identity key:
 * two unrelated make-safes in the same suburb would collapse into one.
 */
const AU_STATE_POSTCODE_RE = /^(?:WA|SA|NSW|VIC|QLD|TAS|NT|ACT)\d{4}$/;

/**
 * Unlabelled tokens are never identity. "Lot 245", "Unit 1203" and "WA 6021" all
 * read as references but describe a property, so two unrelated make-safes would
 * collapse into one. Only an explicit durable label earns an identity key.
 * Under-matching costs a genuinely_unaccounted report, over-matching silently
 * loses work.
 *
 * The PO label alternative is derived from PO_LABEL_PATTERN, the grammar the
 * canonical extractor reads, so it cannot drift into a spelling that produces a PO
 * token while identity.po stays empty and the PO-separation guards stay blind.
 * Spellings outside it yield no key and the row fails open instead.
 */
const LABELLED_IDENTITY_RE = new RegExp(
  `\\b(?:(job)\\s*(?:no\\.?|number|#)|${PO_LABEL_PATTERN}\\s*(?:no\\.?|number|#)?|(?:work\\s*order|w\\/o|our\\s*ref(?:erence)?|ref(?:erence)?|claim)\\s*(?:no\\.?|number|#)?)\\s*[:#-]?\\s*([A-Z0-9][A-Z0-9-]{2,19})\\b`,
  "gi",
);
const PO_LABEL_PREFIX_RE = new RegExp(`^${PO_LABEL_PATTERN}`, "i");

function isAddressLikeToken(normalised: string): boolean {
  return AU_STATE_POSTCODE_RE.test(normalised);
}

/**
 * Namespaced identity keys from explicitly labelled references only. A PO number
 * and a job number that share digits stay distinct.
 */
function labelledIdentityKeys(subject: string | null | undefined): string[] {
  const keys: string[] = [];
  for (const match of String(subject || "").matchAll(LABELLED_IDENTITY_RE)) {
    const label = String(match[0]).toLowerCase();
    const token = normaliseRef(match[2]);
    if (!/\d{3,}/.test(token) || isAddressLikeToken(token)) continue;
    const ns = match[1] ? "JOB" : PO_LABEL_PREFIX_RE.test(label) ? "PO" : "REF";
    // A PO key must be a PO the canonical extractor can also parse (bare digits),
    // otherwise the token would participate in matching while identity.po stays
    // empty and the PO-separation guards could never fire for it.
    if (ns === "PO" && !/^\d{3,}$/.test(token)) continue;
    keys.push(`${ns}:${token}`);
  }
  return keys;
}

function rawReferenceFromText(value: string | null | undefined): string | null {
  const text = String(value || "");
  return text.match(JOB_NUMBER_TEXT_RE)?.[0] ||
    [...text.matchAll(LABELLED_IDENTITY_RE)].find((m) =>
      /\d{3,}/.test(normaliseRef(m[2])) &&
      !isAddressLikeToken(normaliseRef(m[2]))
    )?.[0] || null;
}

/**
 * Fallback identity tokens for sources/captures with no canonical claim. Exact
 * token equality only — never substring containment — so a near-collision between
 * two distinct deliverables cannot silently collapse.
 */
function fallbackIdentityKeys(
  externalRef: string | null | undefined,
  subject: string | null | undefined,
): string[] {
  const keys = new Set<string>();
  const ref = normaliseRef(externalRef);
  if (/\d{3,}/.test(ref) && !isAddressLikeToken(ref)) keys.add(`REF:${ref}`);
  if (/^\d{3,7}$/.test(ref)) keys.add(`JOB:${ref}`);
  const text = String(subject || "");
  const jobNo = subjectJobNumber(text);
  if (jobNo) keys.add(`JOB:${jobNo}`);
  for (const key of labelledIdentityKeys(text)) keys.add(key);
  return [...keys];
}

/**
 * The job-unique tokens a fingerprint may be discriminated by, richest first. Always
 * normalised parsed values — never the raw label text a subject happened to use. Both
 * the enriched (extraction-bearing) and the bare (subject-only) representation of the
 * same instruction are emitted so the two capture paths can meet on one of them.
 */
function canonicalIdentityTokens(input: {
  claim: string;
  workOrder: string;
  keys: string[];
  externalRef?: string | null;
}): string[] {
  const out = new Set<string>();
  if (input.workOrder) out.add(input.workOrder);
  if (input.claim) out.add(input.claim);
  for (const ns of ["JOB:", "REF:", "PO:"]) {
    for (const key of input.keys.filter((k) => k.startsWith(ns))) {
      out.add(key.slice(ns.length));
    }
  }
  const ref = normaliseRef(input.externalRef);
  if (ref) out.add(ref);
  return [...out];
}

/**
 * Canonical identity comes only from evidence that belongs to THIS row: its
 * external_ref, its stored extraction fields and its current subject. body_preview
 * is never parsed for identity — it carries quoted threads and footers as often as
 * it carries this instruction's own reference, and adopting a quoted "PO 4477" as
 * this row's PO names the wrong lineage.
 *
 * Body text still matters, but only as doubt: any PO-shaped label in it, parseable
 * or not, means a PO may be in play that the authoritative fields do not show. That
 * raises poContextAmbiguous, which withholds claim/token identity inference unless
 * both sides carry a reliably parsed explicit PO and those POs are equal. When either
 * side lacks an explicit PO, or its subject PO label could not be parsed at all
 * (poUnparsed, which stays scoped to this row's subject), the doubt stands and no
 * inference is made. Such a row can still be accounted by durable evidence (post id,
 * internet message id, content fingerprint); it simply may not be collapsed on
 * identity inference alone.
 */
function reconcileIdentity(input: {
  externalRef?: string | null;
  subject?: string | null;
  bodyText?: string | null;
  extraction?: any;
}): ReconcileIdentity {
  const parsed = extractBuilderWorkOrderIdentity({
    externalRef: input.externalRef,
    subject: input.subject,
  });
  const extraction = parseObj(input.extraction);
  const claim = normaliseRef(
    extraction.builder_claim_ref || parsed.builder_claim_ref,
  );
  const po = normaliseRef(
    extraction.builder_po_number || parsed.builder_po_number,
  ).replace(/^PO/, "");
  const workOrder = normaliseRef(
    extraction.builder_work_order_number || parsed.builder_work_order_number,
  );
  const keys = fallbackIdentityKeys(input.externalRef, input.subject);
  return {
    claim,
    po,
    workOrder,
    raw: matchBuilderRefText(input.subject) ||
      rawReferenceFromText(input.subject) || input.externalRef ||
      parsed.builder_work_order_number || parsed.builder_claim_ref || null,
    canonicalRefs: canonicalIdentityTokens({
      claim,
      workOrder,
      keys,
      externalRef: input.externalRef,
    }),
    keys,
    // A subject PO label the canonical grammar cannot read means "PO unknown",
    // never "no PO".
    poUnparsed: !po && hasUnparseablePoLabel(input.subject || ""),
    // Body text raises the same doubt whatever the spelling, because we never adopt
    // its number: seeing a PO discussed at all is enough to stop identity aliasing.
    poContextAmbiguous: (!po && hasUnparseablePoLabel(input.subject || "")) ||
      hasAnyPoLabel(input.bodyText || ""),
  };
}

/**
 * Matching keys are normalised ("MLB25096") but jobs and drafts store the hyphenated
 * canonical form, so the operator-facing field is re-hyphenated to the shape an
 * external_ref search actually accepts, matching canonical_po_ref.
 */
function displayClaimRef(claim: string): string | null {
  if (!claim) return null;
  const parts = claim.match(/^([A-Z]+)(\d+)$/);
  return parts ? `${parts[1]}-${parts[2]}` : claim;
}

type Relation = "exact" | "claim_po_alias";

function identityRelation(
  source: ReconcileIdentity,
  captured: ReconcileIdentity,
): Relation | null {
  if (!source.claim || source.claim !== captured.claim) return null;
  // A PO we can see but cannot parse is an unknown PO. Relating on the claim alone
  // would either alias a different PO's capture or read as "no PO on either side",
  // both of which hide a possibly-new deliverable. Only an aligned work order,
  // which carries the PO in its own token, survives.
  if (source.poContextAmbiguous || captured.poContextAmbiguous) {
    // Body doubt only matters while a PO is unknown. When both sides name an
    // explicit PO from authoritative fields the deliverable is already pinned, so
    // equal POs are the same work and different POs are different work.
    if (source.po && captured.po) {
      return source.po === captured.po ? "exact" : null;
    }
    return source.workOrder && source.workOrder === captured.workOrder
      ? "exact"
      : null;
  }
  // Two explicit, different POs are two deliverables. Never collapse them merely
  // because the property/claim is shared.
  if (source.po && captured.po && source.po !== captured.po) return null;
  if (
    (source.workOrder && source.workOrder === captured.workOrder) ||
    (source.po && source.po === captured.po) ||
    (!source.po && !captured.po)
  ) return "exact";
  // A claim-only SOURCE may alias a richer PO-suffixed captured identity. The reverse
  // is deliberately unsafe: an explicit new source PO against a legacy claim-only
  // job can be genuinely new work and must remain visible.
  return !source.po && !!captured.po ? "claim_po_alias" : null;
}

/**
 * Pick the single candidate a source may be accounted against. The pool must describe
 * ONE deliverable: differing captured identities mean the evidence cannot say which
 * capture the source belongs to, so we fail open and let the row report as unaccounted
 * rather than name the wrong lineage.
 *
 * A deliverable is claim + PO. workOrder is derived enrichment — the same instruction
 * stored as "MLB-25096-PO-4477" and as "MLB-25096" with an extracted PO resolves to
 * two different workOrder tokens while describing one job — so it is not a
 * distinctness signal.
 */
function soleCompatibleCandidate<T extends { identity: ReconcileIdentity }>(
  pool: T[],
): T | undefined {
  const first = pool[0];
  if (!first) return undefined;
  const distinct = pool.some((c) =>
    c.identity.claim !== first.identity.claim ||
    c.identity.po !== first.identity.po
  );
  return distinct ? undefined : first;
}

/**
 * Choose which of the drafts sharing a content fingerprint the source is a twin of.
 * PO separation is enforced first, then the surviving candidates must describe ONE
 * deliverable: differing captured identities under one fingerprint mean the evidence
 * cannot say which draft the source belongs to, so we fail open and let the row report
 * as unaccounted rather than name the wrong draft.
 */
function resolveFingerprintTwin(
  candidates:
    | { draft: IntakeReconDraft; identity: ReconcileIdentity }[]
    | undefined,
  source: ReconcileIdentity,
): IntakeReconDraft | undefined {
  // Two explicit, different POs are two deliverables, whatever else aligns. An
  // explicit source PO against a PO-less capture is potentially new work too, so the
  // widened token set may never route around PO separation.
  const compatible = (candidates || []).filter((c) =>
    !c.identity.poUnparsed &&
    (source.po ? source.po === c.identity.po : !source.poUnparsed)
  );
  if (!compatible.length) return undefined;
  const exact = compatible.filter((c) => c.identity.po === source.po);
  const pool = exact.length ? exact : compatible;
  return soleCompatibleCandidate(pool)?.draft;
}

interface CapturedIdentity<T> {
  entry: T;
  identity: ReconcileIdentity;
  /**
   * Normalised sender the capture came from. A bare job/reference number is only
   * unique inside one builder's numbering, so the token fallback is scoped to it.
   */
  scope: string;
}

interface CapturedIndex<T> {
  byClaim: Map<string, CapturedIdentity<T>[]>;
  byKey: Map<string, CapturedIdentity<T>[]>;
}

function normaliseSenderScope(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase();
}

function scopedKey(scope: string, key: string): string {
  return `${scope} ${key}`;
}

function indexCapturedIdentities<T>(
  captured: CapturedIdentity<T>[],
): CapturedIndex<T> {
  const byClaim = new Map<string, CapturedIdentity<T>[]>();
  const byKey = new Map<string, CapturedIdentity<T>[]>();
  for (const c of captured) {
    if (c.identity.claim) {
      const arr = byClaim.get(c.identity.claim);
      if (arr) arr.push(c);
      else byClaim.set(c.identity.claim, [c]);
    }
    // No sender evidence means no same-builder proof, so the row is claim-only.
    if (!c.scope) continue;
    for (const key of c.identity.keys) {
      const k = scopedKey(c.scope, key);
      const arr = byKey.get(k);
      if (arr) arr.push(c);
      else byKey.set(k, [c]);
    }
  }
  return { byClaim, byKey };
}

function findCapturedIdentity<T>(
  source: ReconcileIdentity,
  index: CapturedIndex<T>,
  sourceScope: string,
): { entry: T; relation: Relation } | null {
  // A canonical claim is the strongest identity we have: resolve it exclusively so
  // the weaker token fallback can never route around explicit PO separation.
  if (source.claim) {
    const hits: {
      entry: T;
      identity: ReconcileIdentity;
      relation: Relation;
    }[] = [];
    for (const c of index.byClaim.get(source.claim) || []) {
      const relation = identityRelation(source, c.identity);
      if (relation) {
        hits.push({ entry: c.entry, identity: c.identity, relation });
      }
    }
    if (!hits.length) return null;
    // A claim-only source may alias exactly one PO capture. When the claim carries
    // several distinct PO deliverables the evidence cannot name a lineage, so fail
    // open to genuinely unaccounted instead of pointing at an arbitrary draft.
    const exact = hits.filter((h) => h.relation === "exact");
    const hit = soleCompatibleCandidate(exact.length ? exact : hits);
    return hit ? { entry: hit.entry, relation: hit.relation } : null;
  }
  // A bare number carries no builder namespace, so it may only resolve against a
  // capture from the exact same sender. Fail open across builders: reporting work
  // as genuinely unaccounted is recoverable, collapsing two builders' jobs is not.
  if (!sourceScope) return null;
  for (const key of source.keys) {
    const candidates = index.byKey.get(scopedKey(sourceScope, key)) || [];
    // Same token, different explicit POs are different deliverables; a PO neither
    // side can parse is an unknown PO, not an absent one, so it may not alias either.
    // And when the survivors still describe more than one deliverable no evidence
    // names a lineage, so fail open rather than account against whichever was
    // indexed first.
    // Explicit equal POs on both sides pin the deliverable, so body doubt cannot
    // change what the row is.
    const compatible = candidates.filter((c) =>
      (!!source.po && source.po === c.identity.po) ||
      (!source.po && !source.poContextAmbiguous &&
        !c.identity.poContextAmbiguous)
    );
    if (!compatible.length) continue;
    const exact = compatible.filter((c) => c.identity.po === source.po);
    const c = soleCompatibleCandidate(exact.length ? exact : compatible);
    if (!c) continue;
    return { entry: c.entry, relation: "exact" };
  }
  return null;
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

  const drafts = input.drafts || [];
  const jobs = input.jobs || [];
  const draftsByPostId = new Map<string, IntakeReconDraft>();
  const draftsByInternetId = new Map<string, IntakeReconDraft>();
  // Every draft that lands on a fingerprint, not just the first. A draft publishes its
  // broad claim token as well as its rich work-order token, so two distinct
  // deliverables sharing a claim, sender, subject and minute collide here. Keeping all
  // of them lets the lookup pick on identity instead of insertion order.
  const draftFingerprints = new Map<
    string,
    { draft: IntakeReconDraft; identity: ReconcileIdentity }[]
  >();
  const draftIdentities: CapturedIdentity<IntakeReconDraft>[] = [];
  for (const d of drafts) {
    if (d.graph_message_id) draftsByPostId.set(d.graph_message_id, d);
    if (d.internet_message_id) draftsByInternetId.set(d.internet_message_id, d);
    const identity = reconcileIdentity({
      externalRef: d.external_ref,
      subject: d.subject,
      bodyText: d.body_preview,
      extraction: d.extraction_json,
    });
    draftIdentities.push({
      entry: d,
      identity,
      scope: normaliseSenderScope(d.from_email),
    });
    for (
      const token of identity.canonicalRefs.length
        ? identity.canonicalRefs
        : [null]
    ) {
      const fingerprint = contentFingerprint(
        d.from_email,
        d.subject,
        d.received_at || d.created_at,
        token,
        d.body_preview,
      );
      if (!fingerprint) continue;
      const slot = draftFingerprints.get(fingerprint);
      if (slot) slot.push({ draft: d, identity });
      else draftFingerprints.set(fingerprint, [{ draft: d, identity }]);
    }
  }
  // Jobs carry no sender, so they resolve on canonical prefixed claim/PO identity
  // only. A bare number on a job row is not proof of which builder issued it.
  const jobIdentities: CapturedIdentity<IntakeReconJob>[] = jobs.map((job) => ({
    entry: job,
    identity: reconcileIdentity({ externalRef: job.external_ref }),
    scope: "",
  }));
  const draftIndex = indexCapturedIdentities(draftIdentities);
  const jobIndex = indexCapturedIdentities(jobIdentities);

  const items: IntakeReconcileInvariantItem[] = [];
  const unaccounted: IntakeReconcileInvariantItem[] = [];
  let matched = 0;
  let aliasRevision = 0;

  function record(
    e: IntakeReconEmail,
    classification: IntakeReconcileClassification,
    reason: string,
    evidence: IntakeReconcileEvidencePointer,
    identity: ReconcileIdentity,
  ): void {
    const item: IntakeReconcileInvariantItem = {
      post_id: e.post_id || null,
      subject: e.subject || null,
      from_email: e.from_email || null,
      received_at: e.received_at || null,
      age_minutes: minutesOld(e.received_at, nowMs),
      state: classification === "genuinely_unaccounted"
        ? "unaccounted"
        : "accounted",
      classification,
      reason,
      evidence,
      raw_reference: identity.raw,
      canonical_claim_ref: displayClaimRef(identity.claim),
      canonical_po_ref: identity.po ? `PO-${identity.po}` : null,
    };
    items.push(item);
    if (classification === "matched") matched++;
    else if (classification === "accounted_alias_revision") aliasRevision++;
    else unaccounted.push(item);
  }

  for (const e of input.emails || []) {
    const postId = e.post_id || null;
    const subject = e.subject || "";
    const fromEmail = e.from_email || "";
    const identity = reconcileIdentity({ subject, bodyText: e.body_preview });

    // Exact source evidence linkage remains authoritative and preserves the raw id.
    const directDraft = postId ? draftsByPostId.get(postId) : undefined;
    if (directDraft) {
      record(e, "matched", "source_post_id_matches_draft", {
        kind: "draft",
        id: directDraft.id || directDraft.graph_message_id || postId!,
      }, identity);
      continue;
    }

    // Graph exposes one instruction through group-post and mailbox projections. Only
    // collapse when a durable message id or the existing fail-open content fingerprint
    // proves equivalence. Missing fingerprint inputs never alias.
    const internetTwin = e.internet_message_id
      ? draftsByInternetId.get(e.internet_message_id)
      : undefined;
    const fingerprintTwin = internetTwin || (() => {
      // A draft with no parseable ref publishes its fingerprint under the null
      // discriminator, which contentFingerprint then derives from the subject job
      // number or a body hash. A source carrying "Job No 12345" must still probe that
      // form or the bare job-number archetype can never meet its own capture.
      const tokens: (string | null)[] = [...identity.canonicalRefs, null];
      for (const token of tokens) {
        for (
          const fp of contentFingerprintChecks(
            e.from_email,
            e.subject,
            e.received_at,
            token,
            e.body_preview,
          )
        ) {
          const hit = resolveFingerprintTwin(
            draftFingerprints.get(fp),
            identity,
          );
          if (hit) return hit;
        }
      }
      return undefined;
    })();
    if (fingerprintTwin) {
      record(
        e,
        "accounted_alias_revision",
        internetTwin
          ? "twin_graph_post_same_internet_message_id"
          : "twin_graph_post_content_fingerprint",
        {
          kind: "draft",
          id: fingerprintTwin.id || fingerprintTwin.graph_message_id || "draft",
        },
        identity,
      );
      continue;
    }

    // Deterministic non-work classifications are explicit matched rows, not omitted
    // bookkeeping. Their evidence pointer names the exact gate decision.
    const at = fromEmail.lastIndexOf("@");
    const domain = at >= 0
      ? fromEmail.slice(at + 1).trim().toLowerCase()
      : null;
    if (isOwnDomain(domain)) {
      record(e, "matched", "own_outbound_non_candidate", {
        kind: "classification",
        id: "isOwnDomain",
      }, identity);
      continue;
    }
    if (subjectIsExcludedNonWorkOrder(subject)) {
      record(e, "matched", "excluded_non_work_order_subject", {
        kind: "classification",
        id: "subjectIsExcludedNonWorkOrder",
      }, identity);
      continue;
    }
    if (isPureAckNoAction(subject, !!e.has_attachments)) {
      record(e, "matched", "pure_ack_no_action", {
        kind: "classification",
        id: "isPureAckNoAction",
      }, identity);
      continue;
    }
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
      record(e, "matched", "not_make_safe_candidate", {
        kind: "classification",
        id: "sender_and_subject_floor",
      }, identity);
      continue;
    }

    // Re-send/revision lineage may be represented by a draft or live job. Compare
    // claim and PO independently: claim-only <-> PO-suffixed is an alias; two
    // explicit different POs are never equivalent.
    const draftIdentityHit = findCapturedIdentity(
      identity,
      draftIndex,
      normaliseSenderScope(fromEmail),
    );
    if (draftIdentityHit) {
      record(
        e,
        "accounted_alias_revision",
        draftIdentityHit.relation === "claim_po_alias"
          ? "claim_reference_alias_of_po_captured_draft"
          : "resend_or_revision_matches_draft_identity",
        {
          kind: "draft",
          id: draftIdentityHit.entry.id ||
            draftIdentityHit.entry.graph_message_id || "draft",
        },
        identity,
      );
      continue;
    }
    const jobIdentityHit = findCapturedIdentity(identity, jobIndex, "");
    if (jobIdentityHit) {
      record(
        e,
        "accounted_alias_revision",
        jobIdentityHit.relation === "claim_po_alias"
          ? "claim_reference_alias_of_po_captured_job"
          : "resend_or_revision_matches_live_job_identity",
        {
          kind: "job",
          id: jobIdentityHit.entry.job_id ||
            jobIdentityHit.entry.external_ref ||
            "job",
        },
        identity,
      );
      continue;
    }

    record(
      e,
      "genuinely_unaccounted",
      identity.claim && identity.po
        ? "distinct_claim_po_has_no_draft_or_job"
        : "make_safe_candidate_no_draft_no_job",
      {
        kind: "classification",
        id: "no_durable_capture_evidence",
      },
      identity,
    );
  }

  const accounted = matched + aliasRevision;
  return {
    ok: true,
    window_days: windowDays,
    generated_at: new Date(nowMs).toISOString(),
    live_and_true: unaccounted.length === 0,
    counts: {
      source_emails: (input.emails || []).length,
      matched,
      accounted_alias_revision: aliasRevision,
      accounted,
      genuinely_unaccounted: unaccounted.length,
      unaccounted: unaccounted.length,
    },
    items,
    unaccounted: unaccounted.slice(0, limit),
  };
}

export async function makesafeIntakeReconcileInvariant(
  client: any,
  opts: { nowIso?: string; windowDays?: number; limitUnaccounted?: number } =
    {},
): Promise<IntakeReconcileInvariant> {
  const windowDays = opts.windowDays ?? 7;
  const nowMs = opts.nowIso ? Date.parse(opts.nowIso) : Date.now();
  const sinceIso = new Date(nowMs - windowDays * 86_400_000).toISOString();

  const [emailsRes, draftsRes, jobsRes, companiesRes] = await Promise.all([
    client.from("emails")
      .select(
        "post_id, internet_message_id, subject, from_email, body_preview, received_at, has_attachments",
      )
      .eq("mailbox", "ses@secureworkswa.com.au")
      .is("pii_purged_at", null)
      .gte("received_at", sinceIso)
      .order("received_at", { ascending: false })
      .limit(1000),
    client.from("makesafe_intake_drafts")
      .select(
        "id, graph_message_id, internet_message_id, external_ref, subject, from_email, body_preview, status, received_at, created_at, extraction_json",
      )
      .gte("received_at", sinceIso)
      .limit(1000),
    client.from("makesafe_job_details")
      .select("job_id, external_ref")
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
