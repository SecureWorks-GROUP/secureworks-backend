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
//   - reply/forward-only chatter with no work-order evidence
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
//      / Correction / Crew Report). Reply/forward prefixes are kept as risk
//      flags when evidence exists. Cheap; runs BEFORE
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
import { classifyCancellation } from "./makesafe_cancellation_classifier.ts";
import type { PdfDeclaredTypeResult } from "./makesafe_pdf_declared_type.ts";

// Reply / forward prefixes — anchored at the START of the (trimmed) subject so
// "Software Review" is not treated as a forward. Covers RE:, FW:, FWD:, and the
// space/colon variants Outlook/Graph emit. A reply/forward is a RISK SIGNAL, not
// an exclusion by itself: builders do forward legitimate work orders, and those
// must still be captured when deterministic work-order evidence exists.
const REPLY_FORWARD_RE = /^\s*(re|fw|fwd)\s*:/i;

// ── REPORT-CAPTURE: recognised existing-ref / report-request patterns ─────────
// These match genuine builder follow-up emails (re-attend / roof instructions /
// assessment / new-report-request) that carry a known builder ref but no
// work-order PDF and no standard "NEW WORK ORDER" subject keyword.
// The MLB "Our Ref: MLB-XXXXX" format and the BWCWA "New Make Safe and Report
// Request" format are the two live archetypes (8+ drops in 60 days confirmed).
const REPORT_CAPTURE_PATTERNS: readonly RegExp[] = [
  /\bour\s*ref\b.*\b(mlb|wb|bw|bwc|kba)-?\s*\d+/i, // "Our Ref: MLB-25795 ..."
  /###\s*urgent\s*###.*our\s*ref/i, // "### URGENT ### Our Ref"
  /\burgent\b.*\bour\s*ref\b/i, // "URGENT ... Our Ref"
  /new\s*make\s*safe\s*and\s*report\s*request/i, // BWCWA format
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
  if (/temp\s*fenc|collect|pick\s*up|pickup|retriev/i.test(s)) {
    return "temp_fence";
  }
  if (/re.?attend|reattend/i.test(s)) return "re_attend";
  if (/roof/i.test(s)) return "roof_report";
  if (/assessment|inspect/i.test(s)) return "assessment_report";

  // Body-level signals — used when subject is generic ("Our Ref: ...")
  if (/temp\s*fenc|collect|pick\s*up|pickup|retriev/i.test(b)) {
    return "temp_fence";
  }
  if (/re.?attend|reattend/i.test(b)) return "re_attend";
  if (/roof/i.test(b)) return "roof_report";
  if (/assessment|inspect/i.test(b)) return "assessment_report";

  return "unknown_report";
}

// ── B2 — MODEL-COMMITTED report_type (classification commitment) ────────────────
// The Haiku extraction schema now asks the model to COMMIT a report_type from a
// fixed enum, using the email body + PDF text (which classifyReportType never sees).
// Allowed model values and how they map back to the stored report_type space:
//   roof_report | assessment_report | temp_fence | re_attend  -> committed as-is
//   general_makesafe | not_a_report                           -> null (a physical
//       make-safe work order, NOT a report-only card; storing null keeps it out of
//       the "unclassified report" pile and never forces report-only handling).
//   (anything else / null / "unknown")                        -> model ABSTAINED.
// On abstain we fall back to the keyword classifyReportType(subject, body); its
// unknown_report result is PRESERVED as the safety valve for genuine ambiguity.
const MODEL_REPORT_TYPE_ALIASES: Readonly<
  Record<string, ReportType | "general_makesafe">
> = {
  roof_report: "roof_report",
  roof: "roof_report",
  assessment_report: "assessment_report",
  assessment: "assessment_report",
  assessment_report_quote: "assessment_report",
  temp_fence: "temp_fence",
  temp_fence_makesafe: "temp_fence",
  re_attend: "re_attend",
  reattend: "re_attend",
  general_makesafe: "general_makesafe",
  general: "general_makesafe",
  make_safe: "general_makesafe",
  makesafe: "general_makesafe",
  not_a_report: "general_makesafe",
  none: "general_makesafe",
};

/**
 * Resolve the report_type to store, preferring the model's committed classification
 * (body + PDF aware) and demoting the subject/body keyword heuristic to a fallback
 * used ONLY when the model abstains. Returns a ReportType string or null (null = a
 * general physical make-safe, i.e. not a report-only card). unknown_report is only
 * ever returned by the keyword fallback and is preserved as the needs_review valve.
 */
export function resolveCommittedReportType(
  modelReportType: string | null | undefined,
  subject: string | null | undefined,
  body: string | null | undefined,
): ReportType | null {
  const raw = String(modelReportType ?? "").trim().toLowerCase().replace(
    /[\s-]+/g,
    "_",
  );
  const mapped = raw ? MODEL_REPORT_TYPE_ALIASES[raw] : undefined;
  if (mapped) {
    // A committed general/physical make-safe is stored as null (not a report-only type).
    return mapped === "general_makesafe" ? null : mapped;
  }
  // Model abstained (empty / "unknown_report" / unrecognised) — fall back to keywords.
  return classifyReportType(subject, body);
}

/**
 * Map ONLY the model's committed report_type through the alias table — no keyword
 * fallback. Returns a ReportType, "general_makesafe", or null when the model abstained
 * / gave an unrecognised value. Used by the wrong-type guard to tell a model-committed
 * roof/assessment report (positive evidence) apart from a keyword-fallback guess.
 */
export function mappedModelReportType(
  modelReportType: string | null | undefined,
): ReportType | "general_makesafe" | null {
  const raw = String(modelReportType ?? "").trim().toLowerCase().replace(
    /[\s-]+/g,
    "_",
  );
  if (!raw) return null;
  return MODEL_REPORT_TYPE_ALIASES[raw] ?? null;
}

// ── SHARED draft-status decision ────────────────────────────────────────────────
// A single source of truth for "does this draft go to needs_review or stay draft",
// used by BOTH the scanner (scanSesMakesafes) and the admin reextract action so the
// two paths can never drift. A degraded (dead-key) or report-capture draft is always a
// human docket; a normal WO draft mirrors approveIntakeDraft's required fields (company
// + ref + client + address + a servable WO PDF). Both values are valid per the status
// CHECK constraint (migration 20260602000001).
export function computeIntakeDraftStatus(input: {
  extractionDegraded: boolean;
  isReportCapture: boolean;
  hasCompany: boolean;
  externalRef: string | null | undefined;
  clientName: string | null | undefined;
  siteAddress: string | null | undefined;
  availableWoCount: number;
}): "draft" | "needs_review" {
  if (input.extractionDegraded) return "needs_review";
  if (input.isReportCapture) return "needs_review";
  const missingRequired = !input.hasCompany ||
    !input.externalRef ||
    !input.clientName ||
    !input.siteAddress ||
    input.availableWoCount === 0;
  return missingRequired ? "draft" : "needs_review";
}

// ── PRACTICAL JOB FAMILY classifier ──────────────────────────────────────────
// This is the operator-facing emergency-service taxonomy. It deliberately does NOT replace
// report_type yet; it maps the older report_type/work-order signals into the
// families Marnin wants the board/trade app to reason about.
export type MakeSafeJobFamily =
  | "assessment_report_quote"
  | "roof_report"
  | "temp_fence_makesafe"
  | "general_makesafe"
  | "repair"
  | "restoration";

const RAPID_REPAIR_SUBJECT_RE = /\brapid\s+repairs?\b/i;
const RAPID_REPAIR_DISPATCH_LINE_RE =
  /(?:^|\n)\s*dispatch\s+(?:class|type)\s*:\s*rapid\s+repairs?\s*(?:$|\n)/i;

/**
 * Transport-level repair authority used by deterministic intake and repair
 * reconciliation. A subject may carry the builder's explicit RAPID REPAIR
 * label. Body text must use a labelled dispatch line so an ordinary email
 * signature such as "Repair Coordinator | Rapid Repair" cannot retag a roof or
 * make-safe instruction.
 */
export function hasExplicitRapidRepairSignal(
  subject: string | null | undefined,
  body: string | null | undefined,
): boolean {
  return RAPID_REPAIR_SUBJECT_RE.test(String(subject || "")) ||
    RAPID_REPAIR_DISPATCH_LINE_RE.test(String(body || ""));
}

export function makeSafeJobFamilyLabel(
  family: MakeSafeJobFamily | string | null | undefined,
): string {
  switch (family) {
    case "assessment_report_quote":
      return "Assessment / Quote Report";
    case "roof_report":
      return "Roof Report";
    case "temp_fence_makesafe":
      return "Temporary Fence MakeSafe";
    case "general_makesafe":
      return "MakeSafe";
    case "repair":
      return "Repair";
    case "restoration":
      return "Restoration";
    default:
      return "MakeSafe";
  }
}

/**
 * Classify the practical job family from full subject/body context plus the
 * legacy report_type when available. Priority is intentional:
 * temp fence > AJS physical floor > restoration > explicit roof report >
 * assessment/quote > general physical make-safe.
 * A physical roof make-safe must remain general_makesafe unless the text says
 * roof REPORT / external reporting-system work.
 */
// M-G FIX 2 — temp-fence text signals. The bare `temp fenc` token alone is ambiguous:
// "no temp fencing needed" (an inspection/assessment job - MLB-25777/25206) mentions it
// only to say it is NOT wanted. So:
//   • TEMP_FENCE_TEXT_RE  — any temp-fence mention (the pre-fix signal).
//   • AFFIRM_TEMP_FENCE_RE — an affirmative supply/install/collect/retrieve of temp fencing.
//     This ALWAYS wins: a WO that describes the site ("no fencing on the boundary") and
//     then asks to "supply and install temp fencing" is a real temp-fence job.
//   • NEG_TEMP_FENCE_RE — a negation bound TIGHTLY to the temp-fence token ("no temp fenc",
//     "temp fence not required", "no fencing"). A stray "not" elsewhere in the WO does NOT
//     fire it.
// Classify temp_fence when the text mentions it AND (there is an affirmative request OR
// there is no tight negation). The EXPLICIT typed signal (reportType === "temp_fence")
// still wins outright.
const TEMP_FENCE_TEXT_RE =
  /(temp(?:orary)?\s*fenc|fenc(?:e|ing)\s*(collect|pickup|pick\s*up|retriev)|collect\s+.*fenc|pick\s*up\s+.*fenc|pickup\s+.*fenc|retriev\w*\s+.*fenc)/i;
const AFFIRM_TEMP_FENCE_RE =
  /(supply|install|erect|provide|deliver|hire|set\s*up|put\s*up|collect|pick\s*up|pickup|retriev)\w*[^.]{0,60}?(temp(?:orary)?\s*fenc|fence\s*panel|fenc(?:e|ing))|(temp(?:orary)?\s*fenc|fence\s*panel)[^.]{0,60}?(supply|install|erect|provide|deliver|hire|set\s*up|put\s*up|collect|pick\s*up|pickup|retriev)/i;
const NEG_TEMP_FENCE_RE =
  /\bno\s+(?:temp(?:orary)?\s*)?fenc\w*|\bno\s+fencing\b|(?:temp(?:orary)?\s*fenc\w*|fencing)\s+(?:is\s+|are\s+|will\s+be\s+)?(?:not|n['’]?t|no\s+longer)\s+(?:require|need|necessary)/i;
const STRONG_PHYSICAL_MAKESAFE_RE =
  /\b(tarps?|tarping|temporary\s+(?:roof\s+)?repair|temporary\s+(?:roof\s+)?cover(?:ing)?|emergency\s+(?:repair|works?|attendance)|prevent\s+further\s+(?:damage|water\s+ingress)|stop\s+(?:the\s+)?(?:leak|water\s+ingress)|weatherproof|board\s*up|isolate\s+(?:the\s+)?(?:hazard|area|services?)|secure\s+(?:the\s+)?(?:property|site|opening|roof)|remove\s+(?:the\s+)?(?:hazard|danger))\b/i;
const GENERIC_PHYSICAL_MAKESAFE_RE = /\b(make\s*-?\s*safe|makesafe)\b/i;
const GENERIC_WORK_ORDER_RE = /\b(new\s+work\s+order|work\s+order)\b/i;
const RESTORATION_TEXT_RE =
  /\b(restoration\s+(work|works|services?|scope)|building\s+restoration|water\s+damage\s+restoration|fire\s+damage\s+restoration|restore\s+(the\s+)?(property|building|dwelling|premises))\b/i;

// Ruled 2026-08-28 (repair-siphon taxonomy, CAPTAIN-RULINGS-2026-08-28): the
// replacement VERBS are the deterministic repair signal. Measured on the full
// 61-day corpus (394 deliverables) these patterns hit true fence/gate/sheet
// replacements and nothing else, where the bare word "repair" is 17% precise
// (contaminated by the `Makesafe/Emergency Repairs` header and "make temporary
// repair" phrasing), "carpentry" is 0% (an AJ trade dispatch label) and "shed"
// is 5% (make-safe TO a damaged shed). Nouns stay out; verbs decide.
const REPAIR_REPLACEMENT_SCOPE_RE =
  /\bremove\s+and\s+replace\b|\bremove,?(?:\s+and)?\s+dispose\b[^.]{0,120}?\b(?:install|replace)\b|\bsupply\s+and\s+install\b[^.]{0,80}?\b(?:colou?r\s*bond\w*|fenc\w*|gates?|panels?|sheets?|sheeting)\b/i;
const TEMP_FENCE_SNIPPET_RE = /temp(?:orary)?\s*fenc/i;

/**
 * First replacement-verb match whose snippet is not itself about TEMPORARY
 * fencing ("supply and install temp fencing" is the make-safe fence subtype,
 * never a replacement signal). Returns the matched snippet as the evidence
 * trail, or null.
 */
function matchRepairReplacementScope(text: string): string | null {
  const re = new RegExp(REPAIR_REPLACEMENT_SCOPE_RE.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (!TEMP_FENCE_SNIPPET_RE.test(match[0])) {
      return match[0].slice(0, 160);
    }
    if (match.index === re.lastIndex) re.lastIndex++;
  }
  return null;
}

export interface RepairLegSignal {
  detected: boolean;
  /** The matched scope snippet (or the rapid-repair label) — evidence trail. */
  evidence: string | null;
}

/**
 * Ruling 5 (sealed 2026-08-28, two-card dual scope): a work order carrying an
 * emergency leg PLUS a replacement leg ("install temp fence" + "supply and
 * install 1800H Colorbond fence") mints the make-safe card first and owes a
 * SEPARATE linked SWR- repair child. This detector is family-independent: it
 * reports that a replacement leg exists so intake can park the draft for the
 * human who approves the make-safe card and spawns the child. It never moves
 * the family itself — the make-safe card must keep a make-safe family or the
 * board exclusion filter hides it from the crew.
 */
export function detectRepairLegSignal(
  subject: string | null | undefined,
  body: string | null | undefined,
  context: MakeSafeJobFamilyContext = {},
): RepairLegSignal {
  const text = [body || "", context.pdfScopeText || ""].join("\n")
    .toLowerCase();
  const snippet = matchRepairReplacementScope(text);
  if (snippet) return { detected: true, evidence: snippet };
  if (hasExplicitRapidRepairSignal(subject, body)) {
    return { detected: true, evidence: "rapid_repair_signal" };
  }
  return { detected: false, evidence: null };
}

export interface MakeSafeJobFamilyContext {
  /** Deterministically extracted work-order PDF text. */
  pdfScopeText?: string | null;
  /** True when extracted PDF text is present but contains only boilerplate. */
  pdfOnlyBoilerplate?: boolean;
  /** Canonical company slug or deterministic adapter id. */
  builder?: string | null;
  /**
   * Declared-type header read from the case's WO PDF (charter S1a, Ruling 5).
   * When present it is the TOP evidence signal and decides the family; the
   * scope block is secondary. Supplied by the deterministic planner via
   * extractPdfDeclaredType over the deliverable's own PDF document.
   */
  pdfDeclaredType?: PdfDeclaredTypeResult | null;
}

export interface MakeSafeJobFamilyDecision {
  family: MakeSafeJobFamily | null;
  evidence:
    | "typed_temp_fence"
    | "text_temp_fence"
    | "ajs_make_safe_floor"
    | "ajs_restoration_park"
    | "pdf_declared_type_header"
    | "repair_quote_stage"
    | "repair_replacement_scope"
    | "typed_restoration"
    | "text_restoration_park"
    | "typed_roof_report"
    | "text_roof_report"
    | "typed_assessment_report"
    | "text_assessment_report"
    | "physical_makesafe"
    | "rapid_repair_signal"
    | "identified_wo_repair_complement"
    | "ambiguous_scope";
  /**
   * Ruling 1 quote-stage marker: a builder "please price this" request is a
   * repair-family card at QUOTE stage (pre-deliverable lane), converting into a
   * normal WO+PO deliverable when the real work order arrives.
   */
  quoteStage?: boolean;
}

function isAjsBuilder(builder: string | null | undefined): boolean {
  const key = String(builder || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return key === "aj" || key === "ajs" || key === "ajbr" ||
    key === "ajsajbr";
}

// Ruling 9 (sealed 2026-07-30, AJBR-68592): AJ strip-out works tied to ANOTHER
// PARTY'S restoration job park in the review lane permanently — "a deterministic
// system is required to park this class of case, not guess it." The signal is
// restoration-trade wording in the scope; the park applies only when no physical
// make-safe / fence instruction is present (MLB-27093-style "restoration label +
// complete make safe" scopes stay physical per the same ruling).
const RESTORATION_TRADE_RE =
  /\b(?:restoration\s+(?:trade|builder|company|works?)|carpentry\s+restoration|for\s+restoration\s+(?:trade\s+)?to\s+commence)\b/i;

/**
 * Deterministic family decision used by intake. Unlike the legacy convenience
 * wrapper below, this can abstain so an unclear instruction becomes a
 * reason-coded exception instead of silently guessing general make-safe.
 */
export function decideMakeSafeJobFamily(
  subject: string | null | undefined,
  body: string | null | undefined,
  reportType?: string | null,
  context: MakeSafeJobFamilyContext = {},
): MakeSafeJobFamilyDecision {
  // Track A D6 (standing rule + Ruling 5): the subject line never decides
  // family. The MLB "NEW WORK ORDER" subject is the format for every family,
  // so family evidence reads the body and the WO PDF scope/header only; the
  // subject parameter is retained for call-site compatibility but is
  // format-only and never enters the evidence haystack.
  void subject;
  const text = [
    body || "",
    context.pdfScopeText || "",
  ].join("\n").toLowerCase();
  const rt = String(reportType || "").toLowerCase();

  if (rt === "temp_fence") {
    return { family: "temp_fence_makesafe", evidence: "typed_temp_fence" };
  }
  const affirmativeFenceText = TEMP_FENCE_TEXT_RE.test(text) &&
    (AFFIRM_TEMP_FENCE_RE.test(text) || !NEG_TEMP_FENCE_RE.test(text));

  // Captain's standing ruling: every AJS/AJBR instruction is physical make-safe
  // work. Report/assessment wording must never promote it into a report-only
  // family. Temporary fencing remains a physical make-safe subtype. The ONE
  // sealed carve-out is Ruling 9's restoration-trade park (AJBR-68592): AJ works
  // tied to another party's restoration job, with no physical make-safe or
  // fencing instruction of their own, must park in the review lane unclassified.
  if (isAjsBuilder(context.builder)) {
    if (affirmativeFenceText) {
      return { family: "temp_fence_makesafe", evidence: "text_temp_fence" };
    }
    if (
      RESTORATION_TRADE_RE.test(text) &&
      !STRONG_PHYSICAL_MAKESAFE_RE.test(text) &&
      !GENERIC_PHYSICAL_MAKESAFE_RE.test(text)
    ) {
      return { family: null, evidence: "ajs_restoration_park" };
    }
    return {
      family: "general_makesafe",
      evidence: "ajs_make_safe_floor",
    };
  }

  // Ruling 5 (charter S1a): the WO PDF's declared-type header line is the top
  // evidence signal and decides the family where present. The scope block is
  // secondary; where header and scope/draft inference disagree, the header wins
  // (real flip: MLB-25765+PO-54176 roof_report -> assessment_report). Within a
  // makesafe declaration the temporary-fence subtype still refines from the
  // allocation ("Temporary Fencing") or an affirmative fence scope.
  const declared = context.pdfDeclaredType;
  if (declared?.declaredType) {
    switch (declared.declaredType) {
      case "assessment":
        return {
          family: "assessment_report_quote",
          evidence: "pdf_declared_type_header",
        };
      case "roof":
        return { family: "roof_report", evidence: "pdf_declared_type_header" };
      case "repair":
        // Ruling 8: a scaffolding/access-equipment PO is its own repair
        // deliverable, never a support leg of another family's job.
        return { family: "repair", evidence: "pdf_declared_type_header" };
      case "makesafe":
        return {
          family: declared.fenceSubtype || affirmativeFenceText
            ? "temp_fence_makesafe"
            : "general_makesafe",
          evidence: "pdf_declared_type_header",
        };
    }
  }

  if (affirmativeFenceText) {
    return { family: "temp_fence_makesafe", evidence: "text_temp_fence" };
  }

  if (rt === "restoration") {
    return { family: "restoration", evidence: "typed_restoration" };
  }
  // Ruling 15 (sealed 2026-07-30): restoration is a real family but its recipe
  // is UNSEALED — the deterministic intake must not classify anything as
  // restoration from text. Restoration-flavoured scopes with no physical
  // make-safe instruction park in the review lane instead of being guessed
  // (typed legacy report_type passthrough above is unchanged for stored cards).
  if (
    RESTORATION_TEXT_RE.test(text) &&
    !STRONG_PHYSICAL_MAKESAFE_RE.test(text) &&
    !GENERIC_PHYSICAL_MAKESAFE_RE.test(text)
  ) {
    return { family: null, evidence: "text_restoration_park" };
  }

  // Ruled 2026-08-28: a replacement scope ("remove and replace", "remove and
  // dispose ... install", "supply and install ... Colorbond/fence/gate/panel")
  // with NO make-safe language of its own is a repair deliverable. When
  // make-safe language co-fires the rung falls through instead — the emergency
  // leg wins the card and the replacement leg rides as detectRepairLegSignal
  // evidence for a human-spawned child card (Ruling 5, two-card dual scope).
  if (
    matchRepairReplacementScope(text) &&
    !STRONG_PHYSICAL_MAKESAFE_RE.test(text) &&
    !GENERIC_PHYSICAL_MAKESAFE_RE.test(text)
  ) {
    return { family: "repair", evidence: "repair_replacement_scope" };
  }

  // Concrete protective work outranks a report phrase. A scope that says to
  // tarp a roof and provide a report is still physical make-safe work; the
  // report is a secondary obligation, not a report-only family.
  if (STRONG_PHYSICAL_MAKESAFE_RE.test(text)) {
    return {
      family: "general_makesafe",
      evidence: "physical_makesafe",
    };
  }

  if (
    rt === "roof_report" ||
    /\b(roof\s+(report|assessment\s*report|inspection\s*report)|report\s+.*\broof\b|prime\s+roof\s+report)\b/i
      .test(text)
  ) {
    return {
      family: "roof_report",
      evidence: rt === "roof_report" ? "typed_roof_report" : "text_roof_report",
    };
  }

  if (
    rt === "assessment_report" ||
    /\b(assessment\s*(report)?|assess\s+and\s+quote|inspect\s+and\s+(provide\s+)?quote|quote\s*(request|link|report)?|quotation)\b/i
      .test(text)
  ) {
    return {
      family: "assessment_report_quote",
      evidence: rt === "assessment_report"
        ? "typed_assessment_report"
        : "text_assessment_report",
    };
  }

  if (
    (GENERIC_PHYSICAL_MAKESAFE_RE.test(text) ||
      GENERIC_WORK_ORDER_RE.test(text)) &&
    !context.pdfOnlyBoilerplate
  ) {
    return {
      family: "general_makesafe",
      evidence: "physical_makesafe",
    };
  }

  return { family: null, evidence: "ambiguous_scope" };
}

/**
 * Captain ruling 2026-08-31 (the specification, verbatim): "A properly
 * identified, readable work order that is NOT general make-safe, NOT a roof
 * report, NOT an assessment/quote report, and NOT a temporary fence make-safe
 * IS repair."
 *
 * This is the negative complement the 2026-08-25 scout report warned was
 * unsafe as a bare test, answered: the complement is correct ONLY once the
 * identity and evidence floor has already been passed. It therefore applies
 * strictly to a decision whose abstention evidence is `ambiguous_scope` — a
 * readable scope that matched no family — and never to any other abstention:
 *
 * - `text_restoration_park` / `ajs_restoration_park` stay parked (restoration
 *   stays as it is — Ruling 15 / Ruling 9 are untouched).
 * - Every positive classification (temp fence, general make-safe, roof,
 *   assessment, restoration, declared-type repair) is returned unchanged, so
 *   the complement can never move a classified family.
 * - The caller asserts the floor: `scopeReadable` means an extracted work-order
 *   PDF produced a real scope block (a parse failure, boilerplate-only PDF, or
 *   unreadable document is NOT a readable work order and must keep parking);
 *   `identityProved` means the card resolves exactly one canonical builder
 *   instruction key when read at the repair grain (an unknown builder or
 *   insufficient identity yields no key and must keep parking).
 *
 * The deterministic fate ladder applies the same rule at its LAST exception
 * rung (`makesafe_deterministic_intake.ts`), where chatter, cancellations,
 * unknown builders, quote-stage enquiries, conflicts, identity shortfalls and
 * parse failures have all already fired — so nothing below the quality floor
 * can reach the complement there either.
 *
 * A complement-classified draft still never auto-mints, and the guarantee rests
 * on the MINT-TIME brake, not on the sweep. `approveIntakeDraft`'s
 * `UNATTENDED_INTAKE_APPROVAL` refusal (`index.ts`) judges the FINAL
 * `approvedJobFamily` — the one that will actually be created — and refuses any
 * caller carrying the unattended marker. That is the only reading that cannot be
 * outflanked upstream: `shouldAutoApproveCleanIntake`'s
 * `repair_family_supervised_review` check runs on `resolvedIntakeDraftFamily`
 * (subject + body preview + stored family), while the approval fallback
 * classifies from the full instruction text and only then applies THIS
 * complement, so the two legitimately disagree on a legacy-vintage draft that
 * passes the sweep as `general_makesafe` and resolves `repair` at the mint.
 * Treat the sweep check and the deterministic lane's
 * `deterministicPlanNeedsSupervisedRepairReview` park
 * (`makesafe_deterministic_intake_runtime.ts`) as earlier, weaker layers that
 * park most of the population sooner — never as the guarantee.
 */
export function applyIdentifiedWorkOrderRepairComplement(
  decision: MakeSafeJobFamilyDecision,
  floor: { scopeReadable: boolean; identityProved: boolean },
): MakeSafeJobFamilyDecision {
  if (decision.family !== null) return decision;
  if (decision.evidence !== "ambiguous_scope") return decision;
  if (!floor.scopeReadable || !floor.identityProved) return decision;
  return { family: "repair", evidence: "identified_wo_repair_complement" };
}

export function decideDeterministicMakeSafeJobFamily(
  subject: string | null | undefined,
  body: string | null | undefined,
  reportType?: string | null,
  context: MakeSafeJobFamilyContext = {},
): MakeSafeJobFamilyDecision {
  const decision = decideMakeSafeJobFamily(subject, body, reportType, context);
  if (
    hasExplicitRapidRepairSignal(subject, body) &&
    (decision.family === "general_makesafe" || decision.family === null)
  ) {
    return { family: "repair", evidence: "rapid_repair_signal" };
  }
  return decision;
}

/**
 * Back-compatible classifier for callers whose existing contract requires one
 * of the known families. New intake code should use decideMakeSafeJobFamily so
 * genuine ambiguity stays visible.
 *
 * It wraps the DETERMINISTIC variant, and that is load-bearing rather than
 * tidiness. It previously wrapped decideMakeSafeJobFamily, which carries no
 * rapid-repair upgrade — so on the approval fallback path a work order whose
 * subject reads `**RAPID REPAIR**` was STRUCTURALLY INCAPABLE of becoming a
 * repair job. Not hypothetical: a 90-day sweep found exactly two such subjects
 * and both were approved as general_makesafe, and neither of the two
 * intake-born live repair cards was classified repair at mint.
 *
 * This adds NO new business rule. It gives the fallback exactly the repair
 * signals the deterministic layer already seals — the RAPID REPAIR subject and
 * the labelled `Dispatch Class: Rapid Repairs` line — and the upgrade still
 * fires only when the ladder returned general_makesafe or abstained, so no
 * other family can be overwritten by it. The declared repair PDF header
 * (`Rapid Repairs`, `Scaffolding/Access Equipment`) already reached repair
 * through the shared ladder and is unaffected.
 *
 * Deliberately NOT included: MLB's `Makesafe/Emergency Repairs` work-order
 * category, which is 242 of the last 90 days' headers and which the grammar
 * maps to make-safe on purpose. Reading that label as repair is a captain
 * decision and is not taken here.
 */
export function classifyMakeSafeJobFamily(
  subject: string | null | undefined,
  body: string | null | undefined,
  reportType?: string | null,
  context: MakeSafeJobFamilyContext = {},
): MakeSafeJobFamily {
  return decideDeterministicMakeSafeJobFamily(subject, body, reportType, context)
    .family || "general_makesafe";
}

// ── M-G FIX 2 — top-down taxonomy (Marnin's Emergency-Insurance-Work model) ────
// job_type ∈ {assessment, roof, makesafe, restoration}; makesafe alone has subtype ∈ {general, temp}.
// Derived from the (now negation-aware) flat family so there is ONE classification path
// and the flat `makesafe_job_family` stays the back-compat source every reader already uses.
// The pair is stored alongside the flat family on jobs.metadata (no enum/migration - family
// is JSONB), and re-running this over the freshest text is the drift signal FIX 2's backfill
// walk flags on (never the co-set makesafe_type/report_type fields, which agree wrongly).
export type MakeSafeJobType =
  | "assessment"
  | "roof"
  | "makesafe"
  | "repair"
  | "restoration";
export type MakeSafeSubtype = "general" | "temp" | null;
export interface MakeSafeTaxonomy {
  job_type: MakeSafeJobType;
  makesafe_subtype: MakeSafeSubtype;
  family: MakeSafeJobFamily;
}

export function taxonomyFromFamily(
  family: MakeSafeJobFamily | string,
): MakeSafeTaxonomy {
  switch (family) {
    case "assessment_report_quote":
      return {
        job_type: "assessment",
        makesafe_subtype: null,
        family: "assessment_report_quote",
      };
    case "roof_report":
      return {
        job_type: "roof",
        makesafe_subtype: null,
        family: "roof_report",
      };
    case "temp_fence_makesafe":
      return {
        job_type: "makesafe",
        makesafe_subtype: "temp",
        family: "temp_fence_makesafe",
      };
    case "repair":
      return {
        job_type: "repair",
        makesafe_subtype: null,
        family: "repair",
      };
    case "restoration":
      return {
        job_type: "restoration",
        makesafe_subtype: null,
        family: "restoration",
      };
    default:
      return {
        job_type: "makesafe",
        makesafe_subtype: "general",
        family: "general_makesafe",
      };
  }
}

export function classifyMakeSafeTaxonomy(
  subject: string | null | undefined,
  body: string | null | undefined,
  reportType?: string | null,
): MakeSafeTaxonomy {
  return taxonomyFromFamily(
    classifyMakeSafeJobFamily(subject, body, reportType),
  );
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
export function slugFromRefPrefix(
  prefix: string | null | undefined,
): string | null {
  switch ((prefix || "").toUpperCase()) {
    case "MLB":
      return "mlb";
    case "BWC":
    case "BW":
    case "BWCWA":
      return "builderwest";
    case "WB":
      return "western-building";
    case "KBA":
      return "kba";
    default:
      return null;
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

// ── CANCELLATION — the OPPOSITE of a new work order ─────────────────────────────
// A builder retracting an existing work order (e.g. "CANCELLED WORK ORDER - MLB-25769
// 34 Carbine Loop, Millbridge") carries the words "work order", so it currently slips
// through subjectLooksLikeNewWorkOrder and MINTS a brand-new intake draft — the exact
// MLB-25769 twin-draft incident. A cancellation must NEVER become a new job: this gate
// refuses the legacy draft path and explicitly routes the source to deterministic
// cancellation accounting. Matched on the subject only (the gate's pure signal); the
// two live twins both say "CANCELLED WORK ORDER" in the subject.
/**
 * True when the subject is a recognised CANCELLATION / retraction of an existing work
 * order or job. Narrow by design: a lone "void" or "cancel" without a work/order/job
 * anchor is NOT enough (guards against false drops of a genuine WO whose text merely
 * mentions cancelling something unrelated), but "CANCELLED WORK ORDER", "cancellation",
 * "please cancel this work order", "withdrawn" all match.
 */
export function subjectIsCancellation(
  subject: string | null | undefined,
): boolean {
  return classifyCancellation({ subject }).isCancellation;
}

// ── EXPLICIT REPORT-REQUEST wording ─────────────────────────────────────────────
// A bare "roof" token (classifyReportType's fallback) is NOT proof an email is a
// report-only obligation — "roof make safe" is a physical work order. This matches only
// EXPLICIT report-request language, used to (a) decide whether a stored roof/assessment
// report_type is genuinely evidenced vs a keyword-fallback false positive [wrong-type
// guard], and (b) recognise a make-safe work order that ALSO carries a report obligation
// [combined intake]. Deliberately requires the word "report" (or an equivalent phrase),
// never a lone building-part noun.
const EXPLICIT_REPORT_REQUEST_RE =
  /\b(?:roof|assessment|condition|structural|engineer(?:s|ing)?|inspection|scope|dilapidation|defect)\s+report\b|\breport\s+(?:is\s+)?(?:required|requested|request|needed|and\s+quote|&\s+quote)\b|\b(?:make\s*safe|makesafe)\s+and\s+(?:a\s+)?report\b|\band\s+(?:provide|complete|upload|submit|attach)\s+(?:a\s+|the\s+)?(?:roof\s+|assessment\s+|inspection\s+|condition\s+)?report\b|\bprovide\s+a\s+report\b/i;

/**
 * True when the text carries EXPLICIT report-request wording (e.g. "roof report",
 * "assessment report", "make safe AND report", "and provide a report"). Distinct from a
 * bare "roof"/"assessment" keyword, which classifyReportType uses as a last-resort
 * fallback and which alone is NOT positive report-only evidence.
 */
export function textHasExplicitReportRequest(
  text: string | null | undefined,
): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  return EXPLICIT_REPORT_REQUEST_RE.test(t);
}

// ── B4 — KNOWN-BUILDER NOISE (pricing / disregard / enquiry replies) ───────────
// Narrow, high-confidence phrases for builder follow-ups that are NOT a work order
// or a report: "please disregard", "pricing query/enquiry". These currently ride in
// on a builder ref (matchedCompany!=null -> deterministic evidence) and land a junk
// needs_review card. This list is deliberately conservative and is only ever applied
// when NO work-order PDF and NO positive new-WO subject signal is present (see
// isGenuineNewWorkOrder step 3.5) — so it FAILS OPEN: a WO PDF or a real new-WO
// subject always wins. Deliberately NOT matching bare "quote" (real assessment+quote
// reports use it) or "query" alone (too broad).
const KNOWN_BUILDER_NOISE_SUBJECT_PHRASES: readonly RegExp[] = [
  /please\s+disregard/i, // "please disregard previous"
  /\bdisregard\s+(this|the\s+)?(previous|last|earlier|below)/i,
  /pricing\s+(query|queries|enquiry|enquiries|question|questions|request)/i,
  /\bprice\s+(query|enquiry|question)/i,
] as const;

/**
 * True when the subject is a recognised known-builder NOISE reply (pricing enquiry /
 * "please disregard"). Narrow by design. The caller (isGenuineNewWorkOrder) only
 * consults this when there is no WO PDF and no positive new-WO subject, so it can
 * never drop a genuine work order.
 */
export function subjectIsKnownBuilderNoise(
  subject: string | null | undefined,
): boolean {
  const s = (subject || "").trim();
  if (!s) return false;
  for (const re of KNOWN_BUILDER_NOISE_SUBJECT_PHRASES) {
    if (re.test(s)) return true;
  }
  return false;
}

/**
 * True when the subject carries a reply/forward prefix. This is intentionally
 * exported separately from `subjectIsExcludedNonWorkOrder` so scan code can keep
 * the item visible with review context instead of silently rejecting it.
 */
export function subjectHasReplyForwardPrefix(
  subject: string | null | undefined,
): boolean {
  return REPLY_FORWARD_RE.test((subject || "").trim());
}

/**
 * True when the subject is UNAMBIGUOUSLY not a new work order (crew evidence,
 * report, invoice, correction, crew chatter). Reply/forward is not included here:
 * it is only a risk flag when deterministic work-order evidence exists.
 */
export function subjectIsExcludedNonWorkOrder(
  subject: string | null | undefined,
): boolean {
  const s = (subject || "").trim();
  if (!s) return false; // empty subject is not, by itself, an exclusion signal
  for (const re of NON_WORK_ORDER_SUBJECT_PHRASES) {
    if (re.test(s)) return true;
  }
  return false;
}

/** True when the subject carries a positive NEW work-order signal. */
export function subjectLooksLikeNewWorkOrder(
  subject: string | null | undefined,
): boolean {
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
export function subjectMatchesReportCapture(
  subject: string | null | undefined,
): boolean {
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
export function isReportOnlyType(
  reportType: string | null | undefined,
): boolean {
  return !!reportType && REPORT_ONLY_TYPES.has(reportType as ReportType);
}

// BE-2 (report-types B4) — the canonical job-family -> report-only ReportType
// mapping. classifyMakeSafeJobFamily already encodes the inverse (report_type
// 'roof_report' -> family 'roof_report', 'assessment_report' -> family
// 'assessment_report_quote'); this is the single explicit forward map so the
// job-creation and portal-done-marker paths derive report_type from a PERSISTED
// makesafe_job_family without duplicating the family/type lists.
const REPORT_FAMILY_TO_TYPE: Readonly<Record<string, ReportType>> = {
  roof_report: "roof_report",
  assessment_report_quote: "assessment_report",
};

/**
 * The report-only ReportType token for a report-family job family, or null for
 * non-report families (temp_fence_makesafe, general_makesafe, restoration,
 * unknown). Restoration remains non-report until its recipe is sealed. The
 * result is validated against REPORT_ONLY_TYPES so this map can never silently
 * mint a token the report-only set does not recognise.
 */
export function reportTypeForJobFamily(
  family: string | null | undefined,
): ReportType | null {
  const mapped =
    REPORT_FAMILY_TO_TYPE[String(family || "").trim().toLowerCase()];
  return mapped && REPORT_ONLY_TYPES.has(mapped) ? mapped : null;
}

// A clear, non-actionable acknowledgement: subject is ONLY a thanks/noted/received
// courtesy line with NO address, NO job detail, NO action verb. Err HARD toward
// capture — anything ambiguous stays captured (Codex issue 3, never-miss > tidy).
const ACK_ONLY_RE =
  /^\s*(re|fw|fwd\s*:)?\s*(many\s+)?(thanks|thank\s*you|ta|cheers|noted|received|acknowledg(e|ed|ement)|confirmed|got\s*it|ok(ay)?|received\s*with\s*thanks)\b/i;
// Action / detail words that mean "still do something" — if ANY appear, KEEP.
const ACTION_OR_DETAIL_RE =
  /\b(attend|re.?attend|reattend|report|assess|inspect|roof|fenc|collect|pick\s*up|pickup|retriev|quote|invoice|urgent|asap|site|address|st\b|street|rd\b|road|ave\b|avenue|wa\s*\d{4}|\d{1,4}\s+\w+\s+(st|street|rd|road|ave|avenue|way|cl|close|cres|crescent|pl|place|dr|drive)\b)/i;

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
    .replace(
      /\bour\s*ref\b\s*:?[\s-]*\b(mlb|wb|bw|bwc|bwcwa|kba)-?\s*\d+\b/i,
      "",
    )
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
): {
  ok: boolean;
  reason: string;
  kind: "work_order" | "report";
  reportSubjectPattern: boolean;
  route?: "deterministic_cancellation";
} {
  const s = (subject || "").trim();

  // 1) Our own outbound mail must never become an inbound intake draft. The ses@
  //    group poll sees sent items (Report/Invoice/Photo Evidence sends).
  const at = (fromEmail || "").lastIndexOf("@");
  const fromDomain = at >= 0
    ? (fromEmail as string).slice(at + 1).trim().toLowerCase()
    : null;
  if (isOwnDomain(fromDomain)) {
    return {
      ok: false,
      reason: `outbound:${fromDomain}`,
      kind: "work_order",
      reportSubjectPattern: false,
    };
  }

  // 2) Unambiguous non-WO subjects (photo evidence / report / invoice /
  //    correction / crew chatter) are NEVER a new work order
  //    OR a report-capture candidate, regardless of any PDF.
  //    This is what keeps blocking our outbound acks ("Make Safe Report and Invoice").
  if (subjectIsExcludedNonWorkOrder(s)) {
    return {
      ok: false,
      reason: "excluded_non_work_order_subject",
      kind: "work_order",
      reportSubjectPattern: false,
    };
  }

  // 2.5) CANCELLATION — a retraction of an existing work order ("CANCELLED WORK ORDER
  //      - MLB-25769 ...") carries "work order" and would otherwise pass step 3 and mint
  //      a NEW draft. Recognise it here, BEFORE the positive-WO keyword check, refuse
  //      the legacy draft path, and publish the deterministic cancellation route. This
  //      runs after the exclusion list so an outbound/photo/invoice cancellation is
  //      still handled there.
  if (subjectIsCancellation(s)) {
    return {
      ok: false,
      reason: "cancelled_work_order",
      kind: "work_order",
      reportSubjectPattern: false,
      route: "deterministic_cancellation",
    };
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
    return {
      ok: true,
      reason: "work_order_pdf",
      kind: "work_order",
      reportSubjectPattern,
    };
  }
  if (subjectLooksLikeNewWorkOrder(s)) {
    return {
      ok: true,
      reason: "new_work_order_subject",
      kind: "work_order",
      reportSubjectPattern,
    };
  }

  // 3.5) B4 NOISE GATE — a known-builder pricing/enquiry/"please disregard" reply
  //      with NO WO PDF and NO new-WO subject is not a work order or a report. Drop
  //      it here so it never becomes a junk needs_review card. FAIL OPEN: this only
  //      runs after the PDF and new-WO-subject keeps above, so any real work order
  //      has already returned ok:true; a report-pattern email still reaches step 4.
  if (!hasWorkOrderPdf && subjectIsKnownBuilderNoise(s)) {
    return {
      ok: false,
      reason: "known_builder_noise",
      kind: "work_order",
      reportSubjectPattern,
    };
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
      return {
        ok: false,
        reason: "pure_ack_no_action",
        kind: "work_order",
        reportSubjectPattern: true,
      };
    }
    return {
      ok: true,
      reason: "report_capture_pattern",
      kind: "report",
      reportSubjectPattern: true,
    };
  }

  // 5) No positive signal and no PDF — not enough to call it a new work order
  //    or a report. Drop to avoid flooding the review queue.
  return {
    ok: false,
    reason: "no_work_order_signal",
    kind: "work_order",
    reportSubjectPattern: false,
  };
}
