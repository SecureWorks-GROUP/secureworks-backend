// ════════════════════════════════════════════════════════════
// MAKE-SAFE INTAKE GATE — only intake genuine NEW work orders.
// Mission: makesafe-inbound-filter-2026-06-16
// ════════════════════════════════════════════════════════════
//
// THE BUG THIS FIXES
// ------------------
// scanSesMakesafes (ops-api index.ts) turns ses@ mailbox emails into
// makesafe_intake_drafts rows that flood the ops needs_review queue. Its only
// gate was "subject contains make safe|work order keyword" + a weak Haiku
// "not_a_work_order" hint. That wrongly drafts emails that merely CARRY a
// builder ref in the subject but are NOT new work orders, e.g.:
//   - "Photo Evidence - AJBR 67251 - Doubleview"        (crew evidence, our own)
//   - "Photos - Make Safe - AJBR 66897 - Singleton"     (crew evidence)
//   - "Invoice - AJBR 66902 - Dianella"                 (our outbound / billing)
//   - "Make Safe Report and Invoice - MLB-25369 - ..."  (our outbound send)
//   - "Correction - ...", "WhatsApp Crew Report - ..."  (chatter)
//   - "RE: ...", "FW: ..." replies/forwards
// These have NO work-order PDF and become "0 work order file(s) / Missing:
// work_order_pdf" drafts that a human must reject one by one.
//
// REAL new work orders look like (verified against live drafts):
//   - "NEW WORK ORDER - MLB-25096 7 Broughton St, Balcatta, WA 6021"
//   - "Make Safe - QUINNS ROCKS - Job No 67996"
//   - "Make Safe - BICTON - Job No 67998"
// and they carry a work-order PDF attachment.
//
// DESIGN
// ------
// Two-stage gate, applied in scanSesMakesafes:
//   1. subjectIsExcludedNonWorkOrder(subject) — a SUBJECT-only pre-filter that
//      drops the unambiguous non-WO subjects (Photo Evidence / Report / Invoice
//      / Correction / Crew Report / reply-forward prefixes). Cheap; runs BEFORE
//      the expensive Graph attachment fetch + Haiku call.
//   2. isGenuineNewWorkOrder(subject, fromEmail, workOrderPdfCount) — the hard
//      gate right before the draft insert. A row is created ONLY when the email
//      is NOT an excluded non-WO subject AND it shows a positive new-WO signal:
//        - a work-order PDF attachment is present, OR
//        - the subject matches a new-WO pattern (NEW WORK ORDER / "Make Safe -
//          <…> - Job No <ref>" / a bare "work order").
//
// ADVERSARIAL SAFETY (do NOT drop a real WO)
//   - A builder who sends a WO WITHOUT the words "work order" but WITH a PDF
//     still passes (PDF is a positive signal on its own).
//   - The exclude list is intentionally narrow and unambiguous: it only matches
//     subjects that are categorically not a new WO (photo evidence / report /
//     invoice / correction / crew chatter / replies). It never excludes a plain
//     "Make Safe - <suburb> - Job No <ref>" or "NEW WORK ORDER".
//   - When in doubt (unknown subject + a PDF) we KEEP the email rather than drop
//     it, preferring a false draft over a missed work order.

import { isOwnDomain } from "./makesafe_compact_reads.ts";

// Reply / forward prefixes — anchored at the START of the (trimmed) subject so
// "Software Review" is not treated as a forward. Covers RE:, FW:, FWD:, and the
// space/colon variants Outlook/Graph emit.
const REPLY_FORWARD_RE = /^\s*(re|fw|fwd)\s*:/i;

// ── REPORT-CAPTURE: recognised existing-ref / report-request patterns ─────────
// These match genuine builder follow-up emails (re-attend / roof instructions /
// assessment / new-report-request) that carry a known builder ref but no
// work-order PDF and no standard "NEW WORK ORDER" subject keyword.
// The MLB "Our Ref: MLB-XXXXX" format and the BWCWA "New Make Safe and Report
// Request" format are the two live archetypes (8+ drops in 60 days confirmed).
const REPORT_CAPTURE_PATTERNS: readonly RegExp[] = [
  /\bour\s*ref\b.*\b(mlb|wb|bw|bwc|kba)-?\s*\d+/i,   // "Our Ref: MLB-25795 ..."
  /###\s*urgent\s*###.*our\s*ref/i,                    // "### URGENT ### Our Ref"
  /\burgent\b.*\bour\s*ref\b/i,                        // "URGENT ... Our Ref"
  /new\s*make\s*safe\s*and\s*report\s*request/i,       // BWCWA format
] as const;

// ── REPORT-TYPE classifier ─────────────────────────────────────────────────────
/** Classifies what KIND of report/request an already-captured builder email is. */
export type ReportType =
  | "roof_report"
  | "assessment_report"
  | "temp_fence"
  | "re_attend"
  | "unknown_report";

/**
 * Classify the report type from subject + body text.
 * Subject is checked first; body is used as a tie-breaker for generic subjects
 * like "Our Ref: MLB-25795 - 47 Hale St, Eaton".
 */
export function classifyReportType(
  subject: string | null | undefined,
  body: string | null | undefined,
): ReportType {
  const s = (subject || "").toLowerCase();
  const b = (body || "").toLowerCase();

  // Subject-level signals (most reliable). roof checked before assess/inspect
  // because "roof inspection" is a roof report, not a generic assessment.
  if (/temp\s*fenc|collect|pick\s*up|pickup|retriev/i.test(s)) return "temp_fence";
  if (/re.?attend|reattend/i.test(s)) return "re_attend";
  if (/roof/i.test(s)) return "roof_report";
  if (/assessment|inspect/i.test(s)) return "assessment_report";

  // Body-level signals — used when subject is generic ("Our Ref: ...")
  if (/temp\s*fenc|collect|pick\s*up|pickup|retriev/i.test(b)) return "temp_fence";
  if (/re.?attend|reattend/i.test(b)) return "re_attend";
  if (/roof/i.test(b)) return "roof_report";
  if (/assessment|inspect/i.test(b)) return "assessment_report";

  return "unknown_report";
}

// ── REPORT-CAPTURE: map ref prefix -> canonical company slug ──────────────────
// Slugs must match exactly what is in the makesafe_companies table (confirmed
// from migrations and test fixtures):
//   mlb          -> ML Builders / primeeco.tech senders
//   builderwest  -> Builderwest (BWCWA / BWC prefix)
//   western-building -> Western Building (WB prefix)
//   kba          -> KBA Insurance Repairs (KBA prefix)
// If a prefix cannot be resolved, returns null so the normal company-match
// fallback (sender pattern) takes over.
export function slugFromRefPrefix(prefix: string | null | undefined): string | null {
  switch ((prefix || "").toUpperCase()) {
    case "MLB": return "mlb";
    case "BWC":
    case "BW":
    case "BWCWA": return "builderwest";
    case "WB": return "western-building";
    case "KBA": return "kba";
    default: return null;
  }
}

// Unambiguous NON-work-order subject phrases. Each is matched case-insensitively
// anywhere in the subject. These categorically describe crew evidence, our own
// outbound sends, billing, or corrections — never a NEW work order, regardless of
// any builder ref that rides along in the subject.
const NON_WORK_ORDER_SUBJECT_PHRASES: readonly RegExp[] = [
  /photo\s*evidence/i, // "Photo Evidence - AJBR ..."
  /\bphotos?\b\s*-/i, // "Photos - Make Safe - AJBR ..." (leading "Photos -")
  /make\s*safe\s*report/i, // "Make Safe Report and Invoice - MLB ..."
  /report\s*(and|&)\s*invoice/i, // "... Report and Invoice ..."
  /\binvoice\b/i, // "Invoice - AJBR ..." (our billing / outbound)
  /\bcorrection\b/i, // "Correction - ..."
  /crew\s*report/i, // "WhatsApp Crew Report - ..."
  /\bswms\b\s*(only|update)?\s*-/i, // SWMS-only sends (not a new WO)
] as const;

// Positive NEW-work-order subject signals.
const NEW_WORK_ORDER_SUBJECT_PHRASES: readonly RegExp[] = [
  /new\s*work\s*order/i, // "NEW WORK ORDER - MLB-..."
  /work\s*order/i, // bare "work order" (e.g. "Work Order #...")
  // "Make Safe - <…> - Job No <ref>" — the AJS/other "Job No" new-WO format.
  /make\s*safe\b.*\bjob\s*(no|number|#)/i,
] as const;

/**
 * True when the subject is UNAMBIGUOUSLY not a new work order (crew evidence,
 * report, invoice, correction, crew chatter) or is a reply/forward. Subject-only;
 * safe to run as a cheap pre-filter before any attachment/Haiku work.
 */
export function subjectIsExcludedNonWorkOrder(subject: string | null | undefined): boolean {
  const s = (subject || "").trim();
  if (!s) return false; // empty subject is not, by itself, an exclusion signal
  if (REPLY_FORWARD_RE.test(s)) return true;
  for (const re of NON_WORK_ORDER_SUBJECT_PHRASES) {
    if (re.test(s)) return true;
  }
  return false;
}

/** True when the subject carries a positive NEW work-order signal. */
export function subjectLooksLikeNewWorkOrder(subject: string | null | undefined): boolean {
  const s = (subject || "").trim();
  if (!s) return false;
  for (const re of NEW_WORK_ORDER_SUBJECT_PHRASES) {
    if (re.test(s)) return true;
  }
  return false;
}

/**
 * True when the subject matches a recognised report-capture pattern (existing-ref
 * / report-request). Used to tag report_type REGARDLESS of whether the email also
 * carries a PDF — a roof/assessment report that arrives WITH a PDF is still a
 * report, not a plain work order (Codex issue 1).
 */
export function subjectMatchesReportCapture(subject: string | null | undefined): boolean {
  const s = (subject || "").trim();
  if (!s) return false;
  for (const re of REPORT_CAPTURE_PATTERNS) {
    if (re.test(s)) return true;
  }
  return false;
}

// Report-only types: a report/assessment with NO physical make-safe component.
// These must NOT be approvable into a standard make-safe job yet — report
// handling is a later mission (Codex issue 2).
const REPORT_ONLY_TYPES: ReadonlySet<ReportType> = new Set([
  "roof_report",
  "assessment_report",
]);

/** True for a report-only type that cannot yet be turned into a make-safe job. */
export function isReportOnlyType(reportType: string | null | undefined): boolean {
  return !!reportType && REPORT_ONLY_TYPES.has(reportType as ReportType);
}

// A clear, non-actionable acknowledgement: subject is ONLY a thanks/noted/received
// courtesy line with NO address, NO job detail, NO action verb. Err HARD toward
// capture — anything ambiguous stays captured (Codex issue 3, never-miss > tidy).
const ACK_ONLY_RE = /^\s*(re|fw|fwd\s*:)?\s*(many\s+)?(thanks|thank\s*you|ta|cheers|noted|received|acknowledg(e|ed|ement)|confirmed|got\s*it|ok(ay)?|received\s*with\s*thanks)\b/i;
// Action / detail words that mean "still do something" — if ANY appear, KEEP.
const ACTION_OR_DETAIL_RE = /\b(attend|re.?attend|reattend|report|assess|inspect|roof|fenc|collect|pick\s*up|pickup|retriev|quote|invoice|urgent|asap|site|address|st\b|street|rd\b|road|ave\b|avenue|wa\s*\d{4}|\d{1,4}\s+\w+\s+(st|street|rd|road|ave|avenue|way|cl|close|cres|crescent|pl|place|dr|drive)\b)/i;

/**
 * Light over-capture guard: returns true ONLY for a clear non-actionable
 * acknowledgement (e.g. "Our Ref: MLB-25795 - thanks for the update", no PDF,
 * no address, no action). Anything ambiguous or possibly-real returns false
 * (stays captured). A PDF present always defeats the drop (could be the report).
 */
export function isPureAckNoAction(
  subject: string | null | undefined,
  hasAttachment: boolean,
): boolean {
  if (hasAttachment) return false; // a PDF could be the actual report — never drop
  const s = (subject || "").trim();
  if (!s) return false;
  // ANY action/detail/address word anywhere in the full subject means it is NOT a
  // pure ack — keep it. This is the strong guard: err hard toward capture.
  if (ACTION_OR_DETAIL_RE.test(s)) return false;
  // Strip a leading ref token ("Our Ref: MLB-25795 -") so the courtesy phrase that
  // follows can be matched at the start of the remaining subject.
  const afterRef = s
    .replace(/\bour\s*ref\b\s*:?[\s-]*\b(mlb|wb|bw|bwc|bwcwa|kba)-?\s*\d+\b/i, "")
    .replace(/^[\s\-–—:]+/, "")
    .trim();
  // Drop ONLY when what remains is itself just a courtesy line (thanks/noted/etc).
  return ACK_ONLY_RE.test(afterRef);
}

/**
 * The hard gate: create an intake draft ONLY for a genuine new work order OR a
 * captured report/re-attend email.
 *
 * @param subject            the email subject
 * @param fromEmail          the sender address (used to drop our own outbound)
 * @param workOrderPdfCount  number of work-order PDF attachments resolved for the
 *                           email (0 when none / only inline images / no pdf)
 *
 * Returns { ok, reason, kind, reportSubjectPattern }.
 *   ok=false  → DO NOT create a draft.
 *   ok=true, kind='work_order'  → create a normal WO intake draft.
 *   ok=true, kind='report'      → create a report-capture draft (status needs_review).
 *   reportSubjectPattern=true   → the subject matched a report-capture pattern; the
 *                                  caller MUST set report_type (via classifyReportType)
 *                                  REGARDLESS of kind — a roof/assessment report that
 *                                  arrives WITH a PDF is still a report (Codex issue 1).
 *
 * CRITICAL ORDERING:
 *   own-domain drop   ← runs first (step 1)
 *   exclusion list    ← runs second (step 2) — blocks acks and chatter
 *   positive WO check ← runs third (step 3) — normal work orders
 *   report-capture    ← runs fourth (step 4) — alternative to no_work_order_signal
 *   no signal drop    ← final fallback (step 5)
 *
 * The report-capture pass is ONLY an alternative to the no_work_order_signal
 * drop. It never overrides an exclusion.
 */
export function isGenuineNewWorkOrder(
  subject: string | null | undefined,
  fromEmail: string | null | undefined,
  workOrderPdfCount: number,
): { ok: boolean; reason: string; kind: "work_order" | "report"; reportSubjectPattern: boolean } {
  const s = (subject || "").trim();

  // 1) Our own outbound mail must never become an inbound intake draft. The ses@
  //    group poll sees sent items (Report/Invoice/Photo Evidence sends).
  const at = (fromEmail || "").lastIndexOf("@");
  const fromDomain = at >= 0 ? (fromEmail as string).slice(at + 1).trim().toLowerCase() : null;
  if (isOwnDomain(fromDomain)) {
    return { ok: false, reason: `outbound:${fromDomain}`, kind: "work_order", reportSubjectPattern: false };
  }

  // 2) Unambiguous non-WO subjects (photo evidence / report / invoice /
  //    correction / crew chatter / reply-forward) are NEVER a new work order
  //    OR a report-capture candidate, regardless of any PDF.
  //    This is what keeps blocking our outbound acks ("Make Safe Report and Invoice").
  if (subjectIsExcludedNonWorkOrder(s)) {
    return { ok: false, reason: "excluded_non_work_order_subject", kind: "work_order", reportSubjectPattern: false };
  }

  // Codex issue 1: whether the SUBJECT matches a report-capture pattern is
  // INDEPENDENT of PDF presence. We compute it once and surface it on every ok
  // result so the caller always tags report_type — a report that rides in with a
  // PDF must not be silently treated as a plain work order.
  const reportSubjectPattern = subjectMatchesReportCapture(s);
  const hasWorkOrderPdf = (workOrderPdfCount ?? 0) > 0;

  // 3) Positive WO signal: a work-order PDF OR a new-WO subject pattern.
  //    A report-pattern subject (e.g. BWCWA "New Make Safe and Report Request")
  //    may legitimately also be a make-safe WO; it stays kind='work_order' but
  //    carries reportSubjectPattern so the caller tags report_type too.
  if (hasWorkOrderPdf) {
    return { ok: true, reason: "work_order_pdf", kind: "work_order", reportSubjectPattern };
  }
  if (subjectLooksLikeNewWorkOrder(s)) {
    return { ok: true, reason: "new_work_order_subject", kind: "work_order", reportSubjectPattern };
  }

  // 4) REPORT-CAPTURE: genuine builder follow-up emails that carry a recognised
  //    existing-ref / report-request pattern but no WO PDF and no WO keyword.
  //    These were previously silently dropped with no_work_order_signal.
  //    Only non-own-domain, non-excluded emails can reach here.
  if (reportSubjectPattern) {
    // Codex issue 3 — LIGHT over-capture guard: drop ONLY a clear non-actionable
    // acknowledgement (just thanks/noted, no address/job detail/action, no PDF).
    // Anything ambiguous or possibly-real STAYS captured (never-miss > tidy).
    if (isPureAckNoAction(s, hasWorkOrderPdf)) {
      return { ok: false, reason: "pure_ack_no_action", kind: "work_order", reportSubjectPattern: true };
    }
    return { ok: true, reason: "report_capture_pattern", kind: "report", reportSubjectPattern: true };
  }

  // 5) No positive signal and no PDF — not enough to call it a new work order
  //    or a report. Drop to avoid flooding the review queue.
  return { ok: false, reason: "no_work_order_signal", kind: "work_order", reportSubjectPattern: false };
}
