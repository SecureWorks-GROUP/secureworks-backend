// Deterministic make-safe intake core.
//
// Pure, side-effect-free adapters and case-wide recovery planning. The runtime
// wrapper is the only code allowed to read/write Supabase. No generative model is
// imported or called from this module.

import {
  buildInstructionKey,
  MAKESAFE_NORMALISER_VERSION,
  type MakesafeCaseState,
  type MakesafeReasonCode,
  normaliseMakesafeIdentity,
} from "../_shared/makesafe_intake_case_model.ts";
import {
  parseSubjectFields,
  parseWithTemplate,
  type TemplateParsingRules,
} from "./makesafe_template_parser.ts";
import {
  applyIdentifiedWorkOrderRepairComplement,
  decideDeterministicMakeSafeJobFamily,
  subjectIsExcludedNonWorkOrder,
  subjectIsKnownBuilderNoise,
  textHasExplicitReportRequest,
} from "./makesafe_intake_gate.ts";
import {
  type CancellationClassification,
  classifyCancellation,
} from "./makesafe_cancellation_classifier.ts";
import { canonicalCompanyDedupeKey } from "../_shared/makesafe_refs.ts";
import {
  extractBuilderWorkOrderIdentity,
  isSelfGeneratedMakesafeWorkOrder,
} from "./makesafe_builder_work_order_identity.ts";
import {
  deriveSuburbFromAddress,
  gapFillFromWorkOrderPdf,
  type PdfGapFillField,
  type PdfGapFillValues,
} from "./makesafe_pdf_gap_fill.ts";
import {
  extractPdfDeclaredType,
  type PdfDeclaredTypeResult,
} from "./makesafe_pdf_declared_type.ts";
import { scopeBlockFromPdfText } from "./makesafe_pdf_scope.ts";

export const DETERMINISTIC_INTAKE_VERSION =
  "makesafe-deterministic-intake@2026-08-13.v12";
export const DETERMINISTIC_MANIFEST_VERSION = "makesafe-manifest@2026-07-20.v1";
export { classifyCancellation };
export type { CancellationClassification };

export type AdapterId =
  | "synthetic_livefire"
  | "mlb"
  | "ajs_ajbr"
  | "builderwest"
  | "western"
  | "prime"
  | "rapid"
  | "chatter";
export type StoryEventKind =
  | "instruction"
  | "revision"
  | "attachment"
  | "portal_link"
  | "appointment"
  | "access_outcome"
  | "cancellation"
  | "reporting_request"
  | "deliverable"
  | "reopen";

export interface DeterministicAttachment {
  id: string;
  sourcePostId: string;
  name: string | null;
  contentType: string | null;
  storagePath: string | null;
  status: string | null;
  sizeBytes?: number | null;
  // Content hash from ingest (email_attachments.sha256). Dual-capture stores the
  // same physical message under a Graph transport row and a mailbox transport
  // row; the hash is what lets the planner treat their sha-identical attachments
  // as one document instead of two deliverable signals.
  sha256?: string | null;
  // PDF text extraction is persisted by the bounded one-document worker. These
  // fields are optional for pre-belt rows and fixtures; the planner consumes the
  // exact same extracted text shape as the in-process fallback.
  pdfExtractionStatus?: string | null;
  pdfExtractionText?: string | null;
  pdfExtractionCharCount?: number | null;
  pdfExtractionPageCount?: number | null;
  pdfExtractionExtractor?: string | null;
  pdfExtractionTruncated?: boolean | null;
  pdfExtractionReason?: string | null;
}

export interface DeterministicLink {
  url: string;
  label?: string | null;
  sourcePostId: string;
}

export interface DeterministicPdfDocument {
  sourcePostId: string;
  attachmentId: string;
  attachmentName: string | null;
  status: "extracted" | "quarantined" | "deferred";
  text: string | null;
  charCount: number;
  pageCount: number | null;
  extractor: string | null;
  truncated: boolean;
  reason: string | null;
  sha256?: string | null;
}

export interface DeterministicSourceItem {
  postId: string;
  internetMessageId?: string | null;
  conversationId?: string | null;
  threadId?: string | null;
  replyToPostId?: string | null;
  relatedPostIds?: readonly string[];
  siblingPostIds?: readonly string[];
  fromEmail: string | null;
  fromName?: string | null;
  toEmails?: readonly string[];
  subject: string | null;
  body: string | null;
  receivedAt: string;
  attachments: readonly DeterministicAttachment[];
  links: readonly DeterministicLink[];
  pdfDocuments?: readonly DeterministicPdfDocument[];
  // Set by the runtime from the shared SES mailbox direction classifier. Own
  // outbound copies still belong in structural source accounting, but they are
  // non-work evidence and must never enter the identity-floor denominator.
  direction?: "inbound" | "own_outbound";
  // Present only after the runtime has cryptographically admitted the exact
  // controlled synthetic lane. It is a cleanup/audit marker, never auth proof.
  syntheticLivefireMarker?: string | null;
}

export interface DeterministicCompanyProfile {
  id: string;
  slug: string;
  name: string;
  senderPatterns: readonly string[];
  parsingRules?: TemplateParsingRules | null;
}

export interface ExtractedIdentity {
  syntheticLivefireMarker?: string | null;
  builderSlug: string | null;
  companyId: string | null;
  companyKey: string | null;
  externalRefRaw: string | null;
  builderWoRaw: string | null;
  builderPoRaw: string | null;
  deliverableRefRaw: string | null;
  externalRefCanonical: string | null;
  builderWoCanonical: string | null;
  builderPoCanonical: string | null;
  deliverableRefCanonical: string | null;
  woPoIdentityKey: string | null;
  normaliserVersion: string;
  clientName: string | null;
  clientPhone: string | null;
  clientEmail: string | null;
  siteAddress: string | null;
  siteSuburb: string | null;
  description: string | null;
  jobFamily: string;
}

export type DeterministicIntakeField = PdfGapFillField | "client_email";

export interface DeterministicFieldProvenance {
  method: "deterministic";
  source: "email_text" | "email_subject" | "work_order_pdf_text";
  rule: string;
  sourcePostId: string;
  attachmentId?: string;
  attachmentName?: string | null;
  extractor?: string;
}

export interface AdaptedSource {
  source: DeterministicSourceItem;
  adapterId: AdapterId | null;
  adapterVersion: string;
  intent: "work" | "revision" | "cancellation" | "chatter" | "ambiguous";
  identity: ExtractedIdentity;
  evidence: readonly EvidenceCandidate[];
  story: readonly StoryEvent[];
  parseWarnings: readonly string[];
  fieldProvenance: Readonly<
    Partial<Record<DeterministicIntakeField, DeterministicFieldProvenance>>
  >;
  pdfFieldProvenance: Readonly<
    Partial<Record<PdfGapFillField, DeterministicFieldProvenance>>
  >;
}

export interface EvidenceCandidate {
  requirement: string;
  sourcePostId: string;
  kind: "message" | "thread" | "sender" | "attachment" | "link" | "field";
  locator: string;
  strength: "explicit" | "strong" | "supporting";
  valueHash?: string;
}

export interface StoryEvent {
  key: string;
  sourcePostId: string;
  occurredAt: string;
  kind: StoryEventKind;
  summaryCode: string;
  attachmentId?: string;
  linkUrl?: string;
}

export interface ManifestRequirement {
  id: string;
  required: boolean;
  blocking: "identity" | "live" | "secondary" | "none";
}

export interface EvidenceMapEntry {
  requirement: string;
  required: boolean;
  status: "satisfied" | "missing" | "ambiguous" | "recovery_staged";
  evidence: readonly EvidenceCandidate[];
  searchedSourcePostIds: readonly string[];
  rejectedCandidateLocators: readonly string[];
  nextRecoveryAction: string | null;
}

export type SourceOutcome =
  | "confirmed_canonical_input"
  | "visible_blocked_with_recovery"
  | "reason_coded_exception"
  | "accounted_non_work";

export interface DeterministicSourceClassification {
  postId: string;
  outcome: SourceOutcome;
  instructionKey: string;
  reasonCode: MakesafeReasonCode | null;
}

export interface RecoveryCursor {
  version: string;
  completedStages: readonly string[];
  nextStage: string | null;
  searchedSourcePostIds: readonly string[];
  stagedArtifactKeys: readonly string[];
  sideEffectKeys: Readonly<{
    draft: string;
    job: string;
    pdfs: readonly string[];
    screenshots: readonly string[];
    invoices: readonly string[];
    outboundMessages: readonly string[];
    approvals: readonly string[];
  }>;
}

export interface DeterministicCasePlan {
  instructionKey: string;
  instructionFingerprint: string;
  lineageClusterKey: string;
  parentInstructionKey: string | null;
  parentRelation:
    | "revision_of"
    | "duplicate_of"
    | "cancellation_of"
    | "sibling_of"
    | "reopen_of"
    | null;
  targetRelation: "cancellation_of" | "revision_of" | "reopen_of" | null;
  targetJobId: string | null;
  cycle: number;
  adapterId: AdapterId | null;
  adapterVersion: string;
  manifestVersion: string;
  identity: ExtractedIdentity;
  state: MakesafeCaseState;
  reasonCode: MakesafeReasonCode | null;
  blockedReasons: readonly string[];
  missingFields: readonly string[];
  conflictingFields: Readonly<Record<string, readonly string[]>>;
  sourcePostIds: readonly string[];
  correlatedSourcePostIds: readonly string[];
  primarySourcePostId: string;
  story: readonly StoryEvent[];
  correlatedStory: readonly StoryEvent[];
  evidenceMap: Readonly<Record<string, EvidenceMapEntry>>;
  sourceClassifications: readonly DeterministicSourceClassification[];
  recoveryCursor: RecoveryCursor;
  fieldProvenance: Readonly<
    Partial<Record<DeterministicIntakeField, DeterministicFieldProvenance>>
  >;
  pdfFieldProvenance: Readonly<
    Partial<Record<PdfGapFillField, DeterministicFieldProvenance>>
  >;
  pdfDocuments: readonly DeterministicPdfDocument[];
  // A combined make-safe + report obligation, when the primary is a physical
  // make-safe and a separate report card is still owed. Mirrors the AI intake's
  // extraction.secondary_obligation so a report-family plan carrying this is
  // treated as physical by both prevalidation and the approval split machinery.
  secondaryObligation?:
    | Readonly<{
      type: string;
      reason: string;
      detail?: string;
    }>
    | null;
}

export interface DeterministicIntakePlan {
  version: string;
  aiCalls: 0;
  cases: readonly DeterministicCasePlan[];
  sourceClassifications: readonly DeterministicSourceClassification[];
  totals: {
    sources: number;
    cases: number;
    confirmed: number;
    blocked: number;
    exceptions: number;
    nonWork: number;
    unaccounted: number;
  };
}

export type DeterministicQualityField =
  | "client_name"
  | "client_phone"
  | "client_email"
  | "site_address"
  | "site_suburb"
  | "external_reference"
  | "builder_work_order"
  | "purchase_order"
  | "description";

export interface DeterministicQualityFieldMeasure {
  filled: number;
  total: number;
  percentage: number | null;
}

export interface DeterministicBuilderQualityMeasure {
  instructions: number;
  confirmed_without_human: number;
  blocked_live_job: number;
  reason_coded_exception: number;
  fields: Record<
    DeterministicQualityField,
    DeterministicQualityFieldMeasure
  >;
}

export interface DeterministicIntakeQualityMeasure {
  version: string;
  unit: "canonical_instruction";
  instructions: number;
  confirmed_without_human: number;
  confirmed_without_human_percentage: number | null;
  by_builder: Record<string, DeterministicBuilderQualityMeasure>;
}

export interface Adapter {
  id: AdapterId;
  version: string;
  matches(
    item: DeterministicSourceItem,
    profiles: readonly DeterministicCompanyProfile[],
  ): boolean;
  build(
    item: DeterministicSourceItem,
    profiles: readonly DeterministicCompanyProfile[],
  ): AdaptedSource;
}

const WORK_SIGNAL =
  /\b(new\s+work\s+order|work\s+order|make\s*safe|job\s*(?:no|number|#)|urgent\s+(?:attend|repair)|re-?attend|roof\s+report|assessment\s+report)\b/i;
const APPOINTMENT_SIGNAL =
  /\b(appointment|booked|scheduled|attend(?:ance)?\s+(?:on|at)|between\s+\d|\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i;
const ACCESS_SIGNAL =
  /\b(no\s+access|unable\s+to\s+access|access\s+denied|tenant\s+not\s+home|keys?\s+(?:available|unavailable)|access\s+code)\b/i;
// Explicit revision wording is a revision wherever it appears.
const REVISION_SIGNAL =
  /\b(revis(?:ed|ion)|amend(?:ed|ment)|updated\s+(?:work\s+order|scope|instruction)|supersed(?:e|ed))\b/i;
// The independently catalogued chase shapes (INFO REQUIRED / FOLLOW UP / booking
// chase / RE: on an existing ref) all identify themselves in the SUBJECT. Matching
// those generic tokens body-wide would demote any first-time work order whose body
// merely says "we will follow up with the tenant" into a forked revision case and
// strip it from the strong-instruction anchor that recovers late attachment-only
// evidence, so they are scoped to the subject line.
const REVISION_SUBJECT_SIGNAL =
  /(?:^\s*re\s*:[^\n]*\b(?:MLB|AJBR|AJS|BWCWA|WB|RAPID)[-\s#]*\d{3,}\b|\b(?:info\s+required|follow\s*up|booking\s+(?:update|request)|any\s+update)\b)/i;
const REOPEN_SIGNAL =
  /\b(re-?attend|reopen|return\s+(?:visit|to\s+site)|attend\s+again)\b/i;
// Charter 6b + Ruling 12 (sealed): collection, rectification and "-R" reattend
// mail are LIFECYCLE events — cycles on the original job's card, never new
// cards. Each is detected as its own reopen-kind story event so the existing
// cycle/parent-relation machinery carries all three.
const COLLECTION_SIGNAL =
  /\b(?:collect|pick\s*up|pickup|retriev\w*)\b[^.\n]{0,60}\bfenc|\bfenc\w*[^.\n]{0,60}\b(?:collect(?:ion)?|pick\s*up|pickup|retriev\w*)\b/i;
// An ORIGINAL temp-fence WO routinely says "supply temporary fencing and
// collect on completion" — a supply/install instruction with a future
// collection clause is a fresh deliverable, not a collection lifecycle event.
const FENCE_SUPPLY_SIGNAL =
  /\b(?:supply|install\w*|deliver\w*|erect\w*|provide|hire)\b[^.\n]{0,60}\bfenc/i;
function isCollectionLifecycleText(fullText: string): boolean {
  return COLLECTION_SIGNAL.test(fullText) &&
    !FENCE_SUPPLY_SIGNAL.test(fullText);
}
// "Rectify the X which you installed" — rectification of OUR OWN earlier work.
// The our-work anchor (you/your/installed) keeps a builder's own rectification
// scopes out of the lifecycle lane.
const RECTIFICATION_SIGNAL =
  /\brectif\w*\b[^.\n]{0,80}\b(?:you|your|installed|erected|supplied)\b|\b(?:you|your)\b[^.\n]{0,40}\brectif\w*\b/i;
// Ruling 12: the "-R" suffix on a builder ref is the reattend marker. The base
// ref stays the identity (binds to the parent); the suffix opens the cycle.
const REATTEND_REF_SUFFIX_SIGNAL =
  /\b(?:AJBR|ABJR|AJS|MLB|BWCWA|WB)[-\s#]*\d{3,}\s*-\s*R(?![A-Za-z0-9])/i;

function isLifecycleReopenText(fullText: string): boolean {
  return REOPEN_SIGNAL.test(fullText) ||
    isCollectionLifecycleText(fullText) ||
    RECTIFICATION_SIGNAL.test(fullText) ||
    REATTEND_REF_SUFFIX_SIGNAL.test(fullText);
}
// Ruling 1 (sealed 2026-07-30): an explicit "please price this" request. The
// verb-phrase anchor matches the live MLB dispatch shorthand ("Pls price:",
// "plds price", "please quote") without swallowing every WO whose scope merely
// mentions the word quote — assessment report & quote deliverables keep their
// own family.
const QUOTE_REQUEST_SIGNAL =
  /\b(?:pl(?:ea)?s?e?|plds)\s+(?:price|quote)\b|\bprice\s*[:;]|\bprovide\s+(?:a\s+|us\s+(?:with\s+)?a\s+)?(?:price|quote|quotation|estimate)\b|\b(?:price|quote)\s+(?:required|please)\b/i;
const REPORT_SIGNAL =
  /\b(report|assessment|inspection|quote|quotation|scope\s+of\s+works)\b/i;
const RAPID_SIGNAL = /\brapid(?:\s+repair(?:s)?)?\b/i;
const PRIME_SIGNAL =
  /\bprime(?:eco|\s+ecosystem|\s+notification|\s+portal)?\b/i;
const AJS_SIGNAL = /\b(?:AJBR|AJS)[-\s#]*\d{3,}\b/i;
const BUILDERWEST_SIGNAL = /\bBWCWA[-\s#]*\d{3,}\b|\bbuilderwest\b/i;
const WESTERN_SIGNAL =
  /\bmake\s+safe\s+work\s+order\s*:\s*WB\d{3,}\b|\bwestern\.mailer\b/i;
const MLB_SIGNAL = /\bMLB[-\s#]*\d{3,}\b/i;
// Require an explicit label delimiter/number token. Bare "NEW WORK ORDER
// MLB-123" proves an instruction and claim, but must not silently promote that
// claim to a builder WO identity.
const WO_RE =
  /\b(?:work\s*order|works\s*order|w\s*[./]?\s*o\s*\.?)\s*(?:(?:number|no\.?)\s*[:#-]?|[:#-])\s*([A-Z]{1,10}[\s._#/-]*\d{3,}(?:[._#/-][A-Z0-9]+)*|\d{3,}(?:[._#/-][A-Z0-9]+)*)\b/i;
const JOB_NO_RE =
  /\bjob\s*(?:no\.?|number|#)\s*[:#-]?\s*([A-Z0-9][A-Z0-9._#/-]{2,})\b/i;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_RE = /(?:\+?61\s*[2-478]|0[2-478])(?:[\s()-]*\d){8}\b/g;
const LABELLED_CLIENT_RE =
  /(?:^|\n)\s*(?:client|insured|customer|contact|home\s*owner|homeowner|policy\s*holders?|owner)\s*(?:name)?\s*[:\-]\s*([A-Za-z][A-Za-z'&.,()/\- ]{1,80})/i;
const LABELLED_ADDRESS_RE =
  /(?:^|\n)\s*(?:site\s*address|risk\s*address|property\s*address|address|property|site)\s*[:\-]\s*([^\n\r]{5,120})/i;
const LABELLED_MOBILE_RE =
  /(?:client\s*)?mobile\s*(?:no\.?|number)?\s*[:\-]\s*((?:\+?61\s*4|04)(?:[\s()-]*\d){8})\b/gi;
const LABELLED_PHONE_RE =
  /(?:client|customer|policy\s*holder|insured)?\s*(?:phone|contact\s*(?:number|no\.?)|tel(?:ephone)?|ph)\s*(?:no\.?|number)?\s*[:\-]\s*((?:\+?61\s*[2-478]|0[2-478])(?:[\s()-]*\d){8})\b/gi;
const LABELLED_EMAIL_RE =
  /(?:client|customer|policy\s*holder|insured)?\s*email\s*[:\-]\s*([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/gi;
const BUILDER_OFFICE_PHONES = new Set([
  "0862630940", // MLB
  "1300257253", // AJS
  "0894211163", // Builderwest
]);
const BUILDER_OFFICE_EMAIL_DOMAINS = new Set([
  "mlbuilders.com.au",
  "ajs.build",
  "primeeco.tech",
  "secureworkswa.com.au",
  "secureworksgroup.app",
]);

function text(item: DeterministicSourceItem): string {
  return `${item.subject || ""}\n${item.body || ""}`;
}

function lifecycleText(item: DeterministicSourceItem): string {
  return `${text(item)}\n${
    item.attachments.map((attachment) => attachment.name || "").join("\n")
  }`;
}

function isRevisionSource(item: DeterministicSourceItem): boolean {
  return REVISION_SIGNAL.test(text(item)) ||
    REVISION_SUBJECT_SIGNAL.test(String(item.subject || ""));
}

function extractedPdfDocuments(
  item: DeterministicSourceItem,
): DeterministicPdfDocument[] {
  return (item.pdfDocuments || []).filter((document) =>
    document.status === "extracted" && !!document.text &&
    !isSelfGeneratedMakesafeWorkOrder(document.attachmentName)
  );
}

function pdfText(item: DeterministicSourceItem): string {
  return extractedPdfDocuments(item).map((document) => document.text).filter(
    Boolean,
  ).join("\n");
}

function pdfScopeText(
  item: DeterministicSourceItem,
  adapterId: AdapterId | null,
): string {
  const documents = extractedPdfDocuments(item);
  const labelledScope = documents.map((document) =>
    scopeBlockFromPdfText(document.text, adapterId)
  ).filter(Boolean).join("\n");
  return labelledScope;
}

function clean(value: unknown): string | null {
  const result = String(value ?? "").replace(/\s+/g, " ").trim();
  return result || null;
}

function canonicalSlug(slug: string): string {
  // Delegate alias detection to the one shared canonical key so the builder
  // alias set never drifts from the make-safe obligation dedupe boundary.
  // canonicalSlug keeps its own display contract ("ajs-ajbr" dashed; the raw
  // lowercased slug for non-alias companies).
  const key = canonicalCompanyDedupeKey(slug);
  if (key === "ajsajbr") return "ajs-ajbr";
  if (key === "rapid") return "rapid";
  if (key === "prime") return "prime";
  if (key === "mlb") return "mlb";
  return slug.toLowerCase();
}

function domainMatches(email: string | null, pattern: string): boolean {
  const e = String(email || "").trim().toLowerCase();
  const p = pattern.trim().toLowerCase().replace(/^\*@/, "").replace(/^@/, "");
  if (!e || !p) return false;
  const domain = e.includes("@") ? e.slice(e.lastIndexOf("@") + 1) : e;
  return domain === p || domain.endsWith(`.${p}`) || e === p;
}

function profileFor(
  adapterId: AdapterId,
  item: DeterministicSourceItem,
  profiles: readonly DeterministicCompanyProfile[],
): DeterministicCompanyProfile | null {
  const aliases = adapterId === "ajs_ajbr"
    ? ["ajs-ajbr"]
    : adapterId === "synthetic_livefire"
    ? ["synthetic-livefire"]
    : adapterId === "builderwest"
    ? ["builderwest", "bw"]
    : adapterId === "western"
    ? ["western", "wb", "western-building"]
    : [adapterId];
  const sender = profiles.find((p) =>
    p.senderPatterns.some((pattern) =>
      domainMatches(item.fromEmail, pattern)
    ) &&
    aliases.includes(canonicalSlug(p.slug))
  );
  if (sender) return sender;
  const exact = profiles.find((p) => aliases.includes(canonicalSlug(p.slug)));
  if (exact) return exact;
  // Prime is a wrapper/notification channel for MLB work, not permission to
  // invent a second builder identity when no dedicated Prime profile exists.
  if (adapterId === "prime") {
    return profiles.find((p) => canonicalSlug(p.slug) === "mlb") || null;
  }
  return null;
}

function normalisePhone(value: string | null | undefined): string | null {
  let digits = String(value || "").replace(/[^\d+]/g, "");
  if (digits.startsWith("+61")) digits = `0${digits.slice(3)}`;
  else if (digits.startsWith("61") && digits.length === 11) {
    digits = `0${digits.slice(2)}`;
  }
  digits = digits.replace(/\D/g, "");
  return digits || null;
}

function builderEmailDomains(
  item: DeterministicSourceItem,
  profile: DeterministicCompanyProfile | null,
): Set<string> {
  const domains = new Set(BUILDER_OFFICE_EMAIL_DOMAINS);
  for (const pattern of profile?.senderPatterns || []) {
    const cleanPattern = String(pattern).trim().toLowerCase()
      .replace(/^\*@/, "").replace(/^@/, "");
    const domain = cleanPattern.includes("@")
      ? cleanPattern.slice(cleanPattern.lastIndexOf("@") + 1)
      : cleanPattern;
    if (domain) domains.add(domain);
  }
  const sender = String(item.fromEmail || "").trim().toLowerCase();
  if (sender.includes("@")) {
    domains.add(sender.slice(sender.lastIndexOf("@") + 1));
  }
  return domains;
}

function isBuilderOfficePhone(value: string | null | undefined): boolean {
  const phone = normalisePhone(value);
  return !!phone && BUILDER_OFFICE_PHONES.has(phone);
}

function isBuilderOfficeEmail(
  value: string | null | undefined,
  item: DeterministicSourceItem,
  profile: DeterministicCompanyProfile | null,
): boolean {
  const email = String(value || "").trim().toLowerCase();
  if (!email.includes("@")) return true;
  if (email === String(item.fromEmail || "").trim().toLowerCase()) return true;
  const domain = email.slice(email.lastIndexOf("@") + 1);
  return [...builderEmailDomains(item, profile)].some((denied) =>
    domain === denied || domain.endsWith(`.${denied}`)
  );
}

function regexCaptureValues(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => clean(match[1] || match[0]))
    .filter((value): value is string => !!value);
}

function selectCustomerPhone(
  item: DeterministicSourceItem,
  parsedValue: string | null | undefined,
): string | null {
  const hay = text(item);
  const candidates = [
    clean(parsedValue),
    ...regexCaptureValues(hay, LABELLED_MOBILE_RE),
    ...regexCaptureValues(hay, LABELLED_PHONE_RE),
    ...[...hay.matchAll(PHONE_RE)].map((match) => clean(match[0])),
  ].filter((value): value is string => !!value);
  const unique = new Map<string, string>();
  for (const value of candidates) {
    const normalised = normalisePhone(value);
    if (!normalised || isBuilderOfficePhone(normalised)) continue;
    if (!unique.has(normalised)) unique.set(normalised, value);
  }
  const values = [...unique.entries()];
  return values.find(([normalised]) => /^04\d{8}$/.test(normalised))?.[1] ||
    values[0]?.[1] || null;
}

function selectCustomerEmail(
  hay: string,
  item: DeterministicSourceItem,
  profile: DeterministicCompanyProfile | null,
  parsedValue?: string | null,
): string | null {
  const candidates = [
    clean(parsedValue),
    ...regexCaptureValues(hay, LABELLED_EMAIL_RE),
    ...[...hay.matchAll(EMAIL_RE)].map((match) => clean(match[0])),
  ].filter((value): value is string => !!value);
  return candidates.find((value) =>
    !isBuilderOfficeEmail(value, item, profile)
  ) || null;
}

function emailFieldProvenance(
  item: DeterministicSourceItem,
  source: "email_text" | "email_subject",
  rule: string,
): DeterministicFieldProvenance {
  return {
    method: "deterministic",
    source,
    rule,
    sourcePostId: item.postId,
  };
}

function pdfFieldProvenance(
  item: DeterministicSourceItem,
  document: DeterministicPdfDocument,
  rule: string,
): DeterministicFieldProvenance {
  return {
    method: "deterministic",
    source: "work_order_pdf_text",
    rule,
    extractor: document.extractor || "unknown",
    sourcePostId: item.postId,
    attachmentId: document.attachmentId,
    attachmentName: document.attachmentName,
  };
}

function senderMatchesAdapter(
  adapterId: AdapterId,
  item: DeterministicSourceItem,
  profiles: readonly DeterministicCompanyProfile[],
): boolean {
  const p = profileFor(adapterId, item, profiles);
  return !!p &&
    p.senderPatterns.some((pattern) => domainMatches(item.fromEmail, pattern));
}

function normaliseAddress(value: string | null): string | null {
  if (!value) return null;
  const n = value.toLowerCase()
    .replace(/\bwestern australia\b|\bw\.?a\.?\b/g, "wa")
    .replace(/\bstreet\b/g, "st")
    .replace(/\broad\b/g, "rd")
    .replace(/\bavenue\b/g, "ave")
    .replace(/\bdrive\b/g, "dr")
    .replace(/\bclose\b/g, "cl")
    .replace(/[^a-z0-9]/g, "");
  return n || null;
}

function normaliseContact(value: string | null): string | null {
  if (!value) return null;
  return value.toLowerCase().replace(/[^a-z0-9]/g, "") || null;
}

function extractLinks(item: DeterministicSourceItem): DeterministicLink[] {
  const byUrl = new Map<string, DeterministicLink>();
  for (const link of item.links) {
    if (/^https:\/\//i.test(link.url)) byUrl.set(link.url, link);
  }
  for (
    const match of String(item.body || "").matchAll(/https:\/\/[^\s<>"']+/gi)
  ) {
    const url = match[0].replace(/[),.;]+$/, "");
    byUrl.set(url, { url, label: null, sourcePostId: item.postId });
  }
  return [...byUrl.values()];
}

function extractRawIdentity(
  item: DeterministicSourceItem,
  adapterId: AdapterId,
): { externalRef: string | null; wo: string | null; po: string | null } {
  // Email stays first so an explicit email value wins. PDF text is a fallback for
  // the common builder shape where the body only says "new work order".
  const hay = `${text(item)}\n${pdfText(item)}`;
  const syntheticExternalRef = adapterId === "synthetic_livefire"
    ? hay.match(/\b(SYNTHLIVE-[A-Z0-9][A-Z0-9._#/-]{2,})\b/i)?.[1] || null
    : null;
  const family = adapterId === "mlb" || adapterId === "prime"
    ? hay.match(/\bMLB[-\s#]*(\d{3,})(?:[-\s]*(?:REV|R)\s*([A-Z0-9]+))?\b/i)
    : adapterId === "ajs_ajbr"
    ? hay.match(
      /\b(?:AJBR|AJS)[-\s#]*(\d{3,})(?:[-\s]*(?:REV|R)\s*([A-Z0-9]+))?\b/i,
    )
    : adapterId === "builderwest"
    ? hay.match(/\bBWCWA[-\s#]*(\d{3,})\b/i)
    : adapterId === "western"
    ? hay.match(/\bWB[-\s#]*(\d{3,})\b/i)
    : adapterId === "synthetic_livefire"
    ? null
    : hay.match(
      /\b(?:RAPID|RR)[-\s#]*(\d{3,})(?:[-\s]*(?:REV|R)\s*([A-Z0-9]+))?\b/i,
    );
  const prefix = adapterId === "ajs_ajbr"
    ? "AJBR"
    : adapterId === "builderwest"
    ? "BWCWA"
    : adapterId === "western"
    ? "WB"
    : adapterId === "rapid"
    ? "RAPID"
    : "MLB";
  const familyExternalRef = syntheticExternalRef ||
    (family
      ? `${prefix}-${family[1]}${family[2] ? `-${family[2]}` : ""}`
      : null);
  const syntheticLabelledWo = adapterId === "synthetic_livefire"
    ? hay.match(
      /\b(?:work\s*order|works\s*order)\s*(?:number|no\.?)?\s*[:#-]\s*(SYNTHLIVE-[A-Z0-9][A-Z0-9._#/-]{2,})\b/i,
    )?.[1] || null
    : null;
  const labelledWo = syntheticLabelledWo || hay.match(WO_RE)?.[1] || null;
  const jobNo = hay.match(JOB_NO_RE)?.[1] || null;
  // AJ's production subjects use "Job No 70062" without repeating AJBR in the
  // subject. The sender-selected adapter supplies that builder scope, so the
  // numeric job number is strong AJBR identity for both the planner and the
  // existing-obligation lookup.
  const preliminaryExternalRef = familyExternalRef ||
    (adapterId === "ajs_ajbr" && /^\d{3,}$/.test(jobNo || "")
      ? `AJBR-${jobNo}`
      : null);
  const attachmentWo = item.attachments
    .filter((attachment) => !isSelfGeneratedMakesafeWorkOrder(attachment.name))
    .map((a) => a.name || "")
    .map((name) => name.match(WO_RE)?.[1] || null)
    .find(Boolean) || null;
  const designatedWorkOrder = item.attachments.some((attachment) =>
    !isSelfGeneratedMakesafeWorkOrder(attachment.name) &&
    attachment.status === "uploaded" &&
    (/pdf/i.test(attachment.contentType || "") ||
      /\.pdf$/i.test(attachment.name || "")) &&
    /work\s*order|works\s*order|(?:^|[^A-Z])WO(?:[^A-Z]|$)/i.test(
      attachment.name || "",
    )
  );
  const builderScopedJobNo = jobNo
    ? adapterId === "ajs_ajbr"
      ? `AJBR-${jobNo}`
      : adapterId === "builderwest"
      ? `BWCWA-${jobNo}`
      : adapterId === "western"
      ? `WB-${jobNo}`
      : adapterId === "rapid"
      ? `RAPID-${jobNo}`
      : jobNo
    : null;
  // PO identity has one grammar for every make-safe path. In particular, the
  // canonical extractor accepts only a numeric PO token and deliberately leaves
  // postal addresses such as "PO Box 2143" empty. Keeping a second permissive
  // planner regex here previously turned every MLB signature into PO "BOX".
  const sharedIdentity = extractBuilderWorkOrderIdentity({
    externalRef: preliminaryExternalRef,
    requestingCompanySlug: adapterId === "ajs_ajbr" ? "aj" : adapterId,
    subject: item.subject,
    bodyText: `${item.body || ""}\n${pdfText(item)}`,
    attachmentNames: item.attachments
      .filter((attachment) =>
        !isSelfGeneratedMakesafeWorkOrder(attachment.name)
      )
      .map((attachment) => attachment.name),
  });
  const externalRef = preliminaryExternalRef ||
    sharedIdentity.builder_claim_ref;
  const po = sharedIdentity.builder_po_number;
  // A labelled WO outranks a claim/reference. A claim is not silently promoted to
  // a WO: claim-only evidence must remain outside confirmed-live state.
  return {
    externalRef,
    wo: labelledWo || attachmentWo || builderScopedJobNo ||
      sharedIdentity.builder_work_order_number ||
      (designatedWorkOrder ? externalRef : null),
    po,
  };
}

// The declared-type header of the deliverable's OWN work-order PDF (charter
// S1a, Ruling 5). One email can carry several WO PDFs with distinct POs; the
// document whose filename carries this source's extracted PO is the deliverable
// being classified. Where no filename identity matches, a unanimous declared
// type across the extracted documents still decides; documents that disagree
// abstain so the ladder falls back to scope evidence — never a guess.
function declaredTypeForSource(
  item: DeterministicSourceItem,
): PdfDeclaredTypeResult | null {
  const documents = extractedPdfDocuments(item);
  if (!documents.length) return null;
  const read = documents.map((document) => ({
    document,
    declared: extractPdfDeclaredType(document.text),
  })).filter((entry) => entry.declared.declaredType);
  if (!read.length) return null;
  const poDigits = extractBuilderWorkOrderIdentity({
    attachmentNames: item.attachments.map((attachment) => attachment.name),
    subject: item.subject,
    bodyText: item.body,
  }).builder_po_number?.replace(/\D/g, "") || null;
  if (poDigits) {
    const owned = read.find((entry) =>
      extractBuilderWorkOrderIdentity({
        attachmentNames: [entry.document.attachmentName],
      }).builder_po_number?.replace(/\D/g, "") === poDigits
    );
    if (owned) return owned.declared;
  }
  const distinct = new Set(
    read.map((entry) =>
      `${entry.declared.declaredType}:${entry.declared.fenceSubtype}`
    ),
  );
  return distinct.size === 1 ? read[0].declared : null;
}

function jobFamilyDecision(
  item: DeterministicSourceItem,
  adapterId: AdapterId | null,
) {
  const pdfDocuments = extractedPdfDocuments(item);
  const fullPdfText = pdfText(item);
  return decideDeterministicMakeSafeJobFamily(item.subject, item.body, null, {
    builder: adapterId,
    pdfScopeText: pdfScopeText(item, adapterId),
    pdfDeclaredType: declaredTypeForSource(item),
    pdfOnlyBoilerplate: pdfDocuments.length > 0 &&
      !pdfScopeText(item, adapterId) &&
      /\b(?:contractors?\s+must|current\s+insurance|terms?\s+and\s+conditions|period\s+trade\s+contract)\b/i
        .test(fullPdfText),
  });
}

function inferDeliverable(
  item: DeterministicSourceItem,
  adapterId: AdapterId | null,
): string {
  const family = jobFamilyDecision(item, adapterId).family || "unclassified";
  const fullText = `${text(item)}\n${pdfScopeText(item, adapterId)}`;
  if (
    REOPEN_SIGNAL.test(fullText) || REATTEND_REF_SUFFIX_SIGNAL.test(fullText)
  ) return `${family}:reopen`;
  if (
    /\bcollect|pick\s*up|retriev/i.test(fullText) && /fenc/i.test(fullText)
  ) {
    return `${family}:collection`;
  }
  if (RECTIFICATION_SIGNAL.test(fullText)) return `${family}:rectification`;
  return family;
}

const PROVENANCE_FIELDS = new Set<DeterministicIntakeField>([
  "client_name",
  "client_phone",
  "client_email",
  "site_address",
  "site_suburb",
  "external_ref",
  "description",
]);

const DERIVED_SUBURB_RULE_PREFIX = "derived_from_site_address:";

function isDerivedSuburbProvenance(
  provenance: DeterministicFieldProvenance | undefined,
): boolean {
  return provenance?.rule.startsWith(DERIVED_SUBURB_RULE_PREFIX) === true;
}

function deriveMissingSiteSuburb(
  fields: Record<string, string>,
  provenance: Partial<
    Record<DeterministicIntakeField, DeterministicFieldProvenance>
  >,
  pdfProvenance: Partial<
    Record<PdfGapFillField, DeterministicFieldProvenance>
  >,
): void {
  if (clean(fields.site_suburb)) return;
  const suburb = deriveSuburbFromAddress(clean(fields.site_address));
  const addressSource = provenance.site_address;
  if (!suburb || !addressSource) return;
  fields.site_suburb = suburb;
  const suburbSource: DeterministicFieldProvenance = {
    ...addressSource,
    rule: `${DERIVED_SUBURB_RULE_PREFIX}${addressSource.rule}`,
  };
  provenance.site_suburb = suburbSource;
  if (suburbSource.source === "work_order_pdf_text") {
    pdfProvenance.site_suburb = suburbSource;
  }
}

function isProvenanceField(value: string): value is DeterministicIntakeField {
  return PROVENANCE_FIELDS.has(value as DeterministicIntakeField);
}

function fieldCandidates(
  item: DeterministicSourceItem,
  profile: DeterministicCompanyProfile | null,
  adapterId: AdapterId | null,
): {
  fields: Record<string, string>;
  provenance: Partial<
    Record<DeterministicIntakeField, DeterministicFieldProvenance>
  >;
  pdfProvenance: Partial<
    Record<PdfGapFillField, DeterministicFieldProvenance>
  >;
  warnings: string[];
} {
  const subjectFields = parseSubjectFields(item.subject);
  const parsed = parseWithTemplate(profile?.parsingRules, {
    subject: item.subject || "",
    body: item.body || "",
    // Only deterministic text already supplied by the source belongs here. The
    // normal path never asks a model to read a scanned document.
    pdfText: "",
  });
  const hay = text(item);
  const client = clean(parsed?.fields.client_name) ||
    clean(hay.match(LABELLED_CLIENT_RE)?.[1]);
  const address = clean(parsed?.fields.site_address) ||
    clean(subjectFields.site_address) ||
    clean(hay.match(LABELLED_ADDRESS_RE)?.[1]);
  let fields: Record<string, string> = { ...(parsed?.fields || {}) };
  if (isBuilderOfficePhone(fields.client_phone)) delete fields.client_phone;
  if (isBuilderOfficeEmail(fields.client_email, item, profile)) {
    delete fields.client_email;
  }
  if (subjectFields.external_ref) {
    fields.external_ref = subjectFields.external_ref;
  }
  if (client) fields.client_name = client;
  if (address) fields.site_address = address;
  if (subjectFields.site_suburb) {
    fields.site_suburb = subjectFields.site_suburb;
  }
  const phone = selectCustomerPhone(item, fields.client_phone);
  if (phone) fields.client_phone = phone;
  else delete fields.client_phone;
  const email = selectCustomerEmail(hay, item, profile, fields.client_email);
  if (email) fields.client_email = email;
  else delete fields.client_email;

  const provenance: Partial<
    Record<DeterministicIntakeField, DeterministicFieldProvenance>
  > = {};
  const pdfProvenance: Partial<
    Record<PdfGapFillField, DeterministicFieldProvenance>
  > = {};
  for (const field of Object.keys(parsed?.fields || {})) {
    if (!fields[field] || !isProvenanceField(field)) continue;
    provenance[field] = emailFieldProvenance(
      item,
      profile?.parsingRules?.fields?.[field]?.source === "subject"
        ? "email_subject"
        : "email_text",
      `company_template:${profile?.parsingRules?.version ?? 0}:${field}`,
    );
  }
  if (subjectFields.external_ref) {
    provenance.external_ref = emailFieldProvenance(
      item,
      "email_subject",
      "subject_fields:external_ref",
    );
  }
  if (subjectFields.site_address && address === subjectFields.site_address) {
    provenance.site_address = emailFieldProvenance(
      item,
      "email_subject",
      "subject_fields:site_address",
    );
  } else if (address) {
    provenance.site_address ||= emailFieldProvenance(
      item,
      "email_text",
      "labelled_email:site_address",
    );
  }
  if (subjectFields.site_suburb) {
    provenance.site_suburb = emailFieldProvenance(
      item,
      "email_subject",
      "subject_fields:site_suburb",
    );
  }
  if (client) {
    provenance.client_name ||= emailFieldProvenance(
      item,
      "email_text",
      "labelled_email:client_name",
    );
  }
  if (phone) {
    provenance.client_phone = emailFieldProvenance(
      item,
      "email_text",
      "ranked_email_contact:client_phone",
    );
  }
  if (email) {
    provenance.client_email = emailFieldProvenance(
      item,
      "email_text",
      "ranked_email_contact:client_email",
    );
  }
  const warnings: string[] = [];
  for (const document of extractedPdfDocuments(item)) {
    const pdfParsed = parseWithTemplate(profile?.parsingRules, {
      subject: "",
      body: "",
      pdfText: document.text || "",
    });
    for (const [field, rawValue] of Object.entries(pdfParsed?.fields || {})) {
      if (
        fields[field] || !isProvenanceField(field) ||
        (field === "client_phone" && isBuilderOfficePhone(rawValue)) ||
        (field === "client_email" &&
          isBuilderOfficeEmail(rawValue, item, profile))
      ) {
        continue;
      }
      const value = clean(rawValue);
      if (!value) continue;
      fields[field] = value;
      const fieldSource = pdfFieldProvenance(
        item,
        document,
        `company_template_pdf:${profile?.parsingRules?.version ?? 0}:${field}`,
      );
      provenance[field] = fieldSource;
      if (field !== "client_email") pdfProvenance[field] = fieldSource;
    }
    const result = gapFillFromWorkOrderPdf({
      current: fields as PdfGapFillValues,
      pdfText: document.text,
      extractor: document.extractor || "unknown",
      sourcePostId: item.postId,
      attachmentId: document.attachmentId,
      attachmentName: document.attachmentName,
    });
    fields = { ...fields, ...result.fields } as Record<string, string>;
    for (const [field, source] of Object.entries(result.provenance)) {
      if (!source || !isProvenanceField(field)) continue;
      provenance[field] = source;
      pdfProvenance[field as PdfGapFillField] = source;
    }
    if (!fields.description) {
      const scopeDescription = scopeBlockFromPdfText(
        document.text,
        adapterId,
      );
      if (scopeDescription) {
        fields.description = scopeDescription;
        const fieldSource = pdfFieldProvenance(
          item,
          document,
          "labelled_pdf:scope_description",
        );
        provenance.description = fieldSource;
        pdfProvenance.description = fieldSource;
      }
    }
    if (!fields.client_email) {
      const pdfEmail = selectCustomerEmail(
        document.text || "",
        item,
        profile,
      );
      if (pdfEmail) {
        fields.client_email = pdfEmail;
        provenance.client_email = pdfFieldProvenance(
          item,
          document,
          "labelled_pdf:client_email",
        );
      }
    }
    if (isBuilderOfficePhone(fields.client_phone)) {
      delete fields.client_phone;
      delete provenance.client_phone;
      delete pdfProvenance.client_phone;
    }
    if (isBuilderOfficeEmail(fields.client_email, item, profile)) {
      delete fields.client_email;
      delete provenance.client_email;
    }
    warnings.push(...result.warnings);
  }
  return { fields, provenance, pdfProvenance, warnings };
}

function storyFor(
  item: DeterministicSourceItem,
  adapterId: AdapterId | null,
): StoryEvent[] {
  const hay = text(item);
  const lifecycleHay = lifecycleText(item);
  const cancellation = classifyCancellation({
    subject: item.subject,
    currentMessageText: item.body,
  });
  const events: StoryEvent[] = [];
  const add = (kind: StoryEventKind, summaryCode: string, suffix = "") => {
    events.push({
      key: `${item.postId}|${kind}|${suffix || summaryCode}`,
      sourcePostId: item.postId,
      occurredAt: item.receivedAt,
      kind,
      summaryCode,
    });
  };
  if (cancellation.isCancellation) {
    add(
      "cancellation",
      `builder_cancelled_instruction:${cancellation.matchedForm}`,
    );
  } else if (isRevisionSource(item)) {
    add("revision", "builder_revised_instruction");
  } else add("instruction", "builder_instruction_received");
  if (APPOINTMENT_SIGNAL.test(hay)) {
    add("appointment", "appointment_or_attendance_time_received");
  }
  if (ACCESS_SIGNAL.test(hay)) {
    add("access_outcome", "site_access_outcome_received");
  }
  if (REOPEN_SIGNAL.test(lifecycleHay)) {
    add("reopen", "return_attendance_requested");
  } else if (REATTEND_REF_SUFFIX_SIGNAL.test(lifecycleHay)) {
    add("reopen", "reattend_ref_suffix_cycle");
  } else if (isCollectionLifecycleText(lifecycleHay)) {
    add("reopen", "fence_collection_requested");
  } else if (RECTIFICATION_SIGNAL.test(lifecycleHay)) {
    add("reopen", "rectification_of_own_work_requested");
  }
  if (REPORT_SIGNAL.test(hay) || textHasExplicitReportRequest(hay)) {
    add("reporting_request", "report_or_quote_requested");
  }
  add("deliverable", `deliverable:${inferDeliverable(item, adapterId)}`);
  for (const attachment of item.attachments) {
    events.push({
      key: `${item.postId}|attachment|${attachment.id}`,
      sourcePostId: item.postId,
      occurredAt: item.receivedAt,
      kind: "attachment",
      summaryCode: attachment.status === "uploaded"
        ? "attachment_available"
        : "attachment_requires_recovery",
      attachmentId: attachment.id,
    });
  }
  for (const link of extractLinks(item)) {
    events.push({
      key: `${item.postId}|portal_link|${link.url}`,
      sourcePostId: item.postId,
      occurredAt: item.receivedAt,
      kind: "portal_link",
      summaryCode: "portal_link_received",
      linkUrl: link.url,
    });
  }
  return events;
}

function evidenceFor(
  item: DeterministicSourceItem,
  identity: ExtractedIdentity,
  fieldProvenance: Readonly<
    Partial<Record<DeterministicIntakeField, DeterministicFieldProvenance>>
  > = {},
): EvidenceCandidate[] {
  const out: EvidenceCandidate[] = [{
    requirement: "source_email",
    sourcePostId: item.postId,
    kind: "message",
    locator: `email:${item.postId}`,
    strength: "explicit",
  }];
  if (item.threadId || item.conversationId || item.internetMessageId) {
    out.push({
      requirement: "thread_relationship",
      sourcePostId: item.postId,
      kind: "thread",
      locator: `thread:${
        item.threadId || item.conversationId || item.internetMessageId
      }`,
      strength: "explicit",
    });
  }
  if (item.fromEmail) {
    out.push({
      requirement: "sender_routing",
      sourcePostId: item.postId,
      kind: "sender",
      locator: `sender:${item.postId}`,
      strength: "strong",
    });
  }
  const fields: Array<[string, string | null]> = [
    ["external_reference", identity.externalRefCanonical],
    ["builder_work_order", identity.builderWoCanonical],
    ["purchase_order", identity.builderPoCanonical],
    ["site_address", identity.siteAddress],
    ["client_name", identity.clientName],
    ["client_phone", identity.clientPhone],
  ];
  for (const [requirement, value] of fields) {
    if (value) {
      const provenanceKey = requirement === "external_reference"
        ? "external_ref"
        : requirement as DeterministicIntakeField;
      const fieldSource = fieldProvenance[provenanceKey];
      out.push({
        requirement,
        sourcePostId: item.postId,
        kind: "field",
        locator: fieldSource?.source === "work_order_pdf_text"
          ? `attachment:${fieldSource.attachmentId}:field:${requirement}`
          : `field:${requirement}:${item.postId}`,
        strength: ["external_reference", "builder_work_order", "purchase_order"]
            .includes(requirement)
          ? "strong"
          : "supporting",
        valueHash: stableHash(value),
      });
    }
  }
  for (const attachment of item.attachments) {
    const pdf = /pdf/i.test(attachment.contentType || "") ||
      /\.pdf$/i.test(attachment.name || "");
    const builderWorkOrderPdf = pdf &&
      !isSelfGeneratedMakesafeWorkOrder(attachment.name);
    out.push({
      requirement: builderWorkOrderPdf
        ? "work_order_attachment"
        : "source_attachment",
      sourcePostId: item.postId,
      kind: "attachment",
      locator: `attachment:${attachment.id}`,
      strength: builderWorkOrderPdf && attachment.status === "uploaded"
        ? "strong"
        : "supporting",
    });
  }
  for (const link of extractLinks(item)) {
    out.push({
      requirement: "portal_link",
      sourcePostId: item.postId,
      kind: "link",
      locator: `link:${stableHash(link.url)}`,
      strength: "strong",
      valueHash: stableHash(link.url),
    });
  }
  return out;
}

function isChatter(item: DeterministicSourceItem): boolean {
  const hay = text(item);
  // The signed lab fixture id is intentionally visible in the subject so the
  // live-fire runner can correlate results. A correction fixture therefore
  // contains the otherwise-global "correction" noise token. Once the runtime
  // has admitted the exact HMAC lane, explicit revision/work-order evidence
  // plus its PDF remains work; unsigned and ordinary builder mail keeps the
  // established exclusion unchanged.
  if (
    item.syntheticLivefireMarker &&
    item.attachments.length > 0 &&
    (isRevisionSource(item) || WORK_SIGNAL.test(hay))
  ) return false;
  return subjectIsExcludedNonWorkOrder(item.subject) ||
    subjectIsKnownBuilderNoise(item.subject) ||
    /\b(thanks|thank\s+you|noted|received|acknowledged|please\s+disregard|pricing\s+(?:query|enquiry)|photo\s+evidence|invoice\s+attached)\b/i
        .test(hay) &&
      !WORK_SIGNAL.test(hay) && item.attachments.length === 0;
}

function buildKnown(
  item: DeterministicSourceItem,
  profiles: readonly DeterministicCompanyProfile[],
  adapterId: Exclude<AdapterId, "chatter">,
): AdaptedSource {
  const profile = profileFor(adapterId, item, profiles);
  const raw = extractRawIdentity(item, adapterId);
  const parsed = fieldCandidates(item, profile, adapterId);
  const fields = { ...parsed.fields };
  if (adapterId === "western") {
    const western = String(item.subject || "").match(
      /make\s+safe\s+work\s+order\s*:\s*(WB\d{3,})\s*[|/]\s*([^|/]+?)\s*[|/]\s*(.+)$/i,
    );
    if (western) {
      fields.external_ref ||= western[1];
      if (!fields.client_name) {
        fields.client_name = western[2].trim();
        parsed.provenance.client_name = emailFieldProvenance(
          item,
          "email_subject",
          "western_subject:client_name",
        );
      }
      if (!fields.site_address) {
        fields.site_address = western[3].trim();
        parsed.provenance.site_address = emailFieldProvenance(
          item,
          "email_subject",
          "western_subject:site_address",
        );
      }
    }
  }
  if (adapterId === "builderwest") {
    const claim = String(item.subject || "").match(
      /^\s*\d{5,}\s*-\s*(BWCWA\d{3,})\s*-\s*([^-]+?)\s*-\s*(.+)$/i,
    );
    if (claim) {
      fields.external_ref ||= claim[1];
      if (!fields.client_name) {
        fields.client_name = claim[2].trim();
        parsed.provenance.client_name = emailFieldProvenance(
          item,
          "email_subject",
          "builderwest_subject:client_name",
        );
      }
      if (!fields.site_address) {
        fields.site_address = claim[3].trim();
        parsed.provenance.site_address = emailFieldProvenance(
          item,
          "email_subject",
          "builderwest_subject:site_address",
        );
      }
    }
  }
  deriveMissingSiteSuburb(
    fields,
    parsed.provenance,
    parsed.pdfProvenance,
  );
  const familyDecision = jobFamilyDecision(item, adapterId);
  const deliverable = inferDeliverable(item, adapterId);
  const canonical = normaliseMakesafeIdentity({
    externalRefRaw: raw.externalRef || fields.external_ref || null,
    builderWoRaw: raw.wo,
    builderPoRaw: raw.po,
    deliverableRefRaw: deliverable,
    prefixes: [
      "SYNTHLIVE",
      "MLB",
      "AJBR",
      "AJS",
      "BWCWA",
      "WB",
      "RAPID",
      "RR",
    ],
  });
  const identity: ExtractedIdentity = {
    syntheticLivefireMarker: item.syntheticLivefireMarker || null,
    // Persist the actual profile slug used by the existing guarded job creator.
    // AJS/AJBR convergence is the stable companyId/companyKey, never slug text.
    builderSlug: profile?.slug ||
      (adapterId === "ajs_ajbr" ? "ajs-ajbr" : adapterId),
    companyId: profile?.id || null,
    companyKey: profile?.id
      ? `company:${encodeURIComponent(profile.id)}`
      : null,
    externalRefRaw: raw.externalRef || fields.external_ref || null,
    builderWoRaw: raw.wo,
    builderPoRaw: raw.po,
    deliverableRefRaw: deliverable,
    ...canonical,
    clientName: clean(fields.client_name),
    clientPhone: clean(fields.client_phone),
    clientEmail: clean(fields.client_email),
    siteAddress: clean(fields.site_address),
    siteSuburb: clean(fields.site_suburb),
    description: clean(fields.description),
    jobFamily: familyDecision.family || "unclassified",
  };
  const hay = text(item);
  const intent = classifyCancellation({
      subject: item.subject,
      currentMessageText: item.body,
    }).isCancellation
    ? "cancellation"
    : isChatter(item)
    ? "chatter"
    : isRevisionSource(item)
    ? "revision"
    : WORK_SIGNAL.test(hay) || item.attachments.length > 0 ||
        extractLinks(item).length > 0 || raw.externalRef || raw.wo || raw.po
    ? "work"
    : "ambiguous";
  return {
    source: item,
    adapterId,
    adapterVersion: `${adapterId}@v1|rules:${
      profile?.parsingRules?.version ?? 0
    }`,
    intent,
    identity,
    evidence: evidenceFor(item, identity, parsed.provenance),
    story: storyFor(item, adapterId),
    parseWarnings: [
      ...(!profile ? ["company_profile_not_resolved"] : []),
      ...(!raw.wo && raw.externalRef ? ["claim_only_identity"] : []),
      `job_family:${familyDecision.evidence}`,
      ...parsed.warnings,
    ],
    fieldProvenance: parsed.provenance,
    pdfFieldProvenance: parsed.pdfProvenance,
  };
}

function blankIdentity(): ExtractedIdentity {
  return {
    syntheticLivefireMarker: null,
    builderSlug: null,
    companyId: null,
    companyKey: null,
    externalRefRaw: null,
    builderWoRaw: null,
    builderPoRaw: null,
    deliverableRefRaw: null,
    externalRefCanonical: null,
    builderWoCanonical: null,
    builderPoCanonical: null,
    deliverableRefCanonical: null,
    woPoIdentityKey: null,
    normaliserVersion: MAKESAFE_NORMALISER_VERSION,
    clientName: null,
    clientPhone: null,
    clientEmail: null,
    siteAddress: null,
    siteSuburb: null,
    description: null,
    jobFamily: "general_makesafe",
  };
}

const SYNTHETIC_LIVEFIRE_ADAPTER: Adapter = {
  id: "synthetic_livefire",
  version: "synthetic_livefire@v1",
  // The runtime sets this only after exact-sender, exact-mailbox, short-expiry
  // HMAC verification. Content alone can never select the synthetic adapter.
  matches: (item) => Boolean(item.syntheticLivefireMarker),
  build: (item, profiles) => buildKnown(item, profiles, "synthetic_livefire"),
};
const MLB_ADAPTER: Adapter = {
  id: "mlb",
  version: "mlb@v1",
  matches: (item, profiles) =>
    MLB_SIGNAL.test(text(item)) ||
    (senderMatchesAdapter("mlb", item, profiles) &&
      !PRIME_SIGNAL.test(`${item.fromEmail || ""} ${item.fromName || ""}`)),
  build: (item, profiles) => buildKnown(item, profiles, "mlb"),
};
const AJS_ADAPTER: Adapter = {
  id: "ajs_ajbr",
  version: "ajs_ajbr@v1",
  matches: (item, profiles) =>
    AJS_SIGNAL.test(text(item)) ||
    senderMatchesAdapter("ajs_ajbr", item, profiles),
  build: (item, profiles) => buildKnown(item, profiles, "ajs_ajbr"),
};
const BUILDERWEST_ADAPTER: Adapter = {
  id: "builderwest",
  version: "builderwest@v1",
  // BuilderWest shares PrimeEco transport with other builders. Require a
  // BuilderWest identity signal; sender-domain matching alone would steal MLB and
  // generic portal notifications from their existing adapters.
  matches: (item) => BUILDERWEST_SIGNAL.test(text(item)),
  build: (item, profiles) => buildKnown(item, profiles, "builderwest"),
};
const WESTERN_ADAPTER: Adapter = {
  id: "western",
  version: "western@v1",
  // Western also arrives over the shared PrimeEco transport. A Western identity
  // signal always selects it, but the sender fallback is guarded the same way MLB
  // guards its own: a wb profile carrying the bare shared domain must not steal
  // BuilderWest work orders or generic portal notifications from their adapters.
  matches: (item, profiles) =>
    WESTERN_SIGNAL.test(
      `${item.fromEmail || ""} ${item.fromName || ""} ${text(item)}`,
    ) ||
    (senderMatchesAdapter("western", item, profiles) &&
      !PRIME_SIGNAL.test(`${item.fromEmail || ""} ${item.fromName || ""}`) &&
      !BUILDERWEST_SIGNAL.test(text(item))),
  build: (item, profiles) => buildKnown(item, profiles, "western"),
};
const PRIME_ADAPTER: Adapter = {
  id: "prime",
  version: "prime@v1",
  matches: (item, profiles) =>
    PRIME_SIGNAL.test(
      `${item.fromEmail || ""} ${item.fromName || ""} ${text(item)}`,
    ) || senderMatchesAdapter("prime", item, profiles),
  build: (item, profiles) => buildKnown(item, profiles, "prime"),
};
const RAPID_ADAPTER: Adapter = {
  id: "rapid",
  version: "rapid@v1",
  matches: (item, profiles) =>
    RAPID_SIGNAL.test(
      `${item.fromEmail || ""} ${item.fromName || ""} ${text(item)}`,
    ) || senderMatchesAdapter("rapid", item, profiles),
  build: (item, profiles) => buildKnown(item, profiles, "rapid"),
};
// Track A D5: the Prime portal's "Email Uploaded" system notification. Both
// live variants are covered: "[PRIME (MLB-26499) Email Uploaded: Re: ..." and
// "[PRIME] (REF) Email Uploaded: Re: ...".
const NOTIFICATION_RELAY_SUBJECT_RE =
  /^\s*\[?\s*prime\b[^\n]{0,60}?\bemail\s+uploaded\b\s*:/i;
const CHATTER_ADAPTER: Adapter = {
  id: "chatter",
  version: "chatter@v1",
  matches: (item) => isChatter(item),
  build: (item) => ({
    source: item,
    adapterId: "chatter",
    adapterVersion: "chatter@v1",
    intent: "chatter",
    identity: blankIdentity(),
    evidence: evidenceFor(item, blankIdentity()),
    story: storyFor(item, "chatter"),
    parseWarnings: [],
    fieldProvenance: {},
    pdfFieldProvenance: {},
  }),
};

// Load-bearing order approved by the deterministic intake contract.
export const DETERMINISTIC_ADAPTER_REGISTRY: readonly Adapter[] = Object.freeze(
  [
    SYNTHETIC_LIVEFIRE_ADAPTER,
    MLB_ADAPTER,
    AJS_ADAPTER,
    WESTERN_ADAPTER,
    BUILDERWEST_ADAPTER,
    PRIME_ADAPTER,
    RAPID_ADAPTER,
    CHATTER_ADAPTER,
  ],
);

export function adaptDeterministicSource(
  item: DeterministicSourceItem,
  profiles: readonly DeterministicCompanyProfile[],
): AdaptedSource {
  if (item.direction === "own_outbound") {
    const identity = blankIdentity();
    return {
      source: item,
      adapterId: "chatter",
      adapterVersion: "chatter@v1|own-outbound",
      intent: "chatter",
      identity,
      evidence: evidenceFor(item, identity),
      story: storyFor(item, "chatter"),
      parseWarnings: ["own_outbound_copy"],
      fieldProvenance: {},
      pdfFieldProvenance: {},
    };
  }
  // Track A D5 (Stage 2a fate taxonomy): a portal notification relay
  // ("[PRIME (REF) Email Uploaded: Re: ...") is transport ABOUT an email,
  // never a builder instruction. It accounts as non-work with no family and
  // no identity — the real deliverable arrives on its own source. The branch
  // deliberately stands down when the relay carries a PDF attachment: a work
  // order PDF is paramount evidence and must never be silently chattered.
  if (
    NOTIFICATION_RELAY_SUBJECT_RE.test(item.subject || "") &&
    !item.attachments.some((attachment) =>
      /pdf/i.test(attachment.contentType || "") ||
      /\.pdf$/i.test(attachment.name || "")
    )
  ) {
    const identity = blankIdentity();
    return {
      source: item,
      adapterId: "chatter",
      adapterVersion: "chatter@v1|notification-relay",
      intent: "chatter",
      identity,
      evidence: evidenceFor(item, identity),
      story: storyFor(item, "chatter"),
      parseWarnings: ["notification_relay"],
      fieldProvenance: {},
      pdfFieldProvenance: {},
    };
  }
  const adapter = DETERMINISTIC_ADAPTER_REGISTRY.find((candidate) =>
    candidate.matches(item, profiles)
  );
  if (adapter) return adapter.build(item, profiles);
  const identity = blankIdentity();
  return {
    source: item,
    adapterId: null,
    adapterVersion: "unknown@v1",
    intent: isChatter(item)
      ? "chatter"
      : WORK_SIGNAL.test(text(item)) || item.attachments.length > 0
      ? "work"
      : "ambiguous",
    identity,
    evidence: evidenceFor(item, identity),
    story: storyFor(item, null),
    parseWarnings: ["unknown_builder"],
    fieldProvenance: {},
    pdfFieldProvenance: {},
  };
}

class UnionFind {
  parent: number[];
  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }
  find(i: number): number {
    return this.parent[i] === i
      ? i
      : (this.parent[i] = this.find(this.parent[i]));
  }
  union(a: number, b: number): void {
    const ar = this.find(a);
    const br = this.find(b);
    if (ar !== br) this.parent[br] = ar;
  }
}

function strongIdentityConflict(a: AdaptedSource, b: AdaptedSource): boolean {
  if (
    a.identity.builderSlug && b.identity.builderSlug &&
    a.identity.builderSlug !== b.identity.builderSlug
  ) return true;
  if (
    a.identity.builderWoCanonical && b.identity.builderWoCanonical &&
    a.identity.builderWoCanonical !== b.identity.builderWoCanonical
  ) return true;
  // Distinct POs are sibling instructions, not an unrelated-case conflict, when a
  // common WO/reference proves the family relationship.
  return false;
}

function instructionReferenceConflict(
  a: AdaptedSource,
  b: AdaptedSource,
): boolean {
  if (strongIdentityConflict(a, b)) return true;
  return !!a.identity.externalRefCanonical &&
    !!b.identity.externalRefCanonical &&
    a.identity.externalRefCanonical !== b.identity.externalRefCanonical;
}

// Normalised correlation coordinates, computed once per adapted source. The
// pairwise pass runs inside builder buckets only, so the regex normalisers are
// never re-run per candidate pair.
interface CorrelationKeys {
  builderSlug: string | null;
  address: string | null;
  client: string | null;
  contact: string | null;
}

function correlationKeysFor(item: AdaptedSource): CorrelationKeys {
  return {
    builderSlug: item.identity.builderSlug,
    address: normaliseAddress(item.identity.siteAddress),
    client: normaliseContact(item.identity.clientName),
    contact: normaliseContact(
      item.identity.clientPhone || item.identity.clientEmail,
    ),
  };
}

// Identity/address correlation for a pair already known to share a non-null
// builder slug. Explicit thread relationships are unioned separately and are not
// subject to the conflict guard.
function correlatedWithinBuilder(
  a: AdaptedSource,
  b: AdaptedSource,
  ka: CorrelationKeys,
  kb: CorrelationKeys,
): boolean {
  if (strongIdentityConflict(a, b)) return false;
  const sameWo = !!a.identity.builderWoCanonical &&
    a.identity.builderWoCanonical === b.identity.builderWoCanonical;
  const sameRef = !!a.identity.externalRefCanonical &&
    a.identity.externalRefCanonical === b.identity.externalRefCanonical;
  const samePo = !!a.identity.builderPoCanonical &&
    a.identity.builderPoCanonical === b.identity.builderPoCanonical;
  if (sameWo || sameRef) return true;
  if (samePo) {
    // A PO is supporting identity, not permission to merge two explicit claims.
    // This keeps legitimate same-claim/same-PO copies together while preventing
    // one reused or misread PO from becoming a cross-claim union edge.
    const distinctExplicitRefs = !!a.identity.externalRefCanonical &&
      !!b.identity.externalRefCanonical &&
      a.identity.externalRefCanonical !== b.identity.externalRefCanonical;
    if (distinctExplicitRefs && !sameWo) return false;
    return true;
  }
  // Address-only is never enough. Supporting address evidence may correlate only
  // with builder plus client/contact, and never across conflicting strong identity.
  return !!ka.address && ka.address === kb.address &&
    ((!!ka.client && ka.client === kb.client) ||
      (!!ka.contact && ka.contact === kb.contact));
}

function mergeField(
  values: readonly (string | null)[],
): { value: string | null; conflicts: string[] } {
  const cleanValues = values.map(clean).filter((v): v is string => !!v);
  const byNorm = new Map<string, string>();
  for (const value of cleanValues) {
    byNorm.set(value.toLowerCase().replace(/[^a-z0-9]/g, ""), value);
  }
  return byNorm.size <= 1
    ? { value: cleanValues[0] || null, conflicts: [] }
    : { value: null, conflicts: [...byNorm.values()].sort() };
}

function bestIdentity(
  items: readonly AdaptedSource[],
): {
  identity: ExtractedIdentity;
  conflicts: Record<string, string[]>;
  fieldProvenance: Partial<
    Record<DeterministicIntakeField, DeterministicFieldProvenance>
  >;
  pdfFieldProvenance: Partial<
    Record<PdfGapFillField, DeterministicFieldProvenance>
  >;
} {
  const ordered = [...items].sort((a, b) =>
    a.source.receivedAt.localeCompare(b.source.receivedAt) ||
    a.source.postId.localeCompare(b.source.postId)
  );
  const base = ordered.find((i) => i.identity.builderSlug) || ordered[0];
  const conflicts: Record<string, string[]> = {};
  const preferredItems = (
    identityField: keyof ExtractedIdentity,
    provenanceField: DeterministicIntakeField,
  ) => {
    const candidates = ordered.filter((item) =>
      clean(item.identity[identityField]) !== null
    );
    const emailDerived = candidates.filter((item) =>
      item.fieldProvenance[provenanceField]?.source !==
        "work_order_pdf_text"
    );
    return emailDerived.length ? emailDerived : candidates;
  };
  const preferredMerge = (
    identityField: keyof ExtractedIdentity,
    provenanceField: DeterministicIntakeField,
  ) => {
    const preferred = preferredItems(identityField, provenanceField);
    return {
      ...mergeField(
        preferred.map((item) => clean(item.identity[identityField])),
      ),
      preferred,
    };
  };
  const preferredStrong = (
    identityField: keyof ExtractedIdentity,
    provenanceField: DeterministicIntakeField,
  ) =>
    clean(
      preferredItems(identityField, provenanceField)[0]?.identity[
        identityField
      ],
    );
  const client = preferredMerge("clientName", "client_name");
  const phone = preferredMerge("clientPhone", "client_phone");
  const email = preferredMerge("clientEmail", "client_email");
  const mergedAddress = preferredMerge("siteAddress", "site_address");
  const explicitSuburbCandidates = ordered.filter((item) =>
    clean(item.identity.siteSuburb) !== null &&
    !isDerivedSuburbProvenance(item.fieldProvenance.site_suburb)
  );
  const emailExplicitSuburbCandidates = explicitSuburbCandidates.filter(
    (item) =>
      item.fieldProvenance.site_suburb?.source !== "work_order_pdf_text",
  );
  const explicitSuburbItem =
    (emailExplicitSuburbCandidates.length
      ? emailExplicitSuburbCandidates
      : explicitSuburbCandidates)[0] || null;
  const explicitSuburb = clean(explicitSuburbItem?.identity.siteSuburb);
  const explicitAddress = clean(explicitSuburbItem?.identity.siteAddress);
  const mergedAddressSuburb = deriveSuburbFromAddress(mergedAddress.value);
  const unpairedExplicitConflict = Boolean(
    explicitSuburb && !explicitAddress &&
      (!mergedAddressSuburb ||
        explicitSuburb.toLowerCase() !== mergedAddressSuburb.toLowerCase()),
  );
  const address = explicitAddress
    ? { ...mergedAddress, value: explicitAddress }
    : mergedAddress;
  const selectedAddressItem = explicitAddress
    ? explicitSuburbItem
    : address.preferred.find((item) =>
      clean(item.identity.siteAddress) === clean(address.value) &&
      !!item.fieldProvenance.site_address
    ) || null;
  if (client.conflicts.length) conflicts.client_name = client.conflicts;
  if (phone.conflicts.length) conflicts.client_phone = phone.conflicts;
  if (email.conflicts.length) conflicts.client_email = email.conflicts;
  if (address.conflicts.length) conflicts.site_address = address.conflicts;
  if (unpairedExplicitConflict) {
    conflicts.site_suburb = [
      ...new Set([
        ...(mergedAddressSuburb ? [mergedAddressSuburb] : []),
        explicitSuburb!,
      ]),
    ].sort();
  }
  const strong = (field: keyof ExtractedIdentity) => {
    const candidates = ordered.map((i) => i.identity[field]).filter((
      v,
    ): v is string => typeof v === "string" && !!v);
    return candidates[0] || null;
  };
  const derivedMergedSuburb = explicitSuburb
    ? null
    : deriveSuburbFromAddress(address.value);
  const identity: ExtractedIdentity = {
    ...base.identity,
    companyId: strong("companyId"),
    companyKey: strong("companyKey"),
    externalRefRaw: preferredStrong("externalRefRaw", "external_ref"),
    builderWoRaw: strong("builderWoRaw"),
    builderPoRaw: strong("builderPoRaw"),
    deliverableRefRaw: strong("deliverableRefRaw"),
    externalRefCanonical: preferredStrong(
      "externalRefCanonical",
      "external_ref",
    ),
    builderWoCanonical: strong("builderWoCanonical"),
    builderPoCanonical: strong("builderPoCanonical"),
    deliverableRefCanonical: strong("deliverableRefCanonical"),
    woPoIdentityKey: strong("woPoIdentityKey"),
    clientName: client.value,
    clientPhone: phone.value,
    clientEmail: email.value,
    siteAddress: address.value,
    siteSuburb: unpairedExplicitConflict
      ? null
      : explicitSuburb || derivedMergedSuburb,
    description: preferredStrong("description", "description"),
    jobFamily: strong("jobFamily") || "general_makesafe",
  };
  const fieldMap: Array<
    [DeterministicIntakeField, keyof ExtractedIdentity, string | null]
  > = [
    ["client_name", "clientName", identity.clientName],
    ["client_phone", "clientPhone", identity.clientPhone],
    ["client_email", "clientEmail", identity.clientEmail],
    ["site_address", "siteAddress", identity.siteAddress],
    ["site_suburb", "siteSuburb", identity.siteSuburb],
    ["external_ref", "externalRefRaw", identity.externalRefRaw],
    ["description", "description", identity.description],
  ];
  const fieldProvenance: Partial<
    Record<DeterministicIntakeField, DeterministicFieldProvenance>
  > = {};
  const pdfFieldProvenance: Partial<
    Record<PdfGapFillField, DeterministicFieldProvenance>
  > = {};
  for (const [provenanceField, identityField, selectedValue] of fieldMap) {
    if (!selectedValue) continue;
    const preferred = preferredItems(identityField, provenanceField);
    const selected = provenanceField === "site_address" && selectedAddressItem
      ? selectedAddressItem
      : provenanceField === "site_suburb" && explicitSuburbItem
      ? explicitSuburbItem
      : preferred.find((item) =>
        clean(item.identity[identityField]) === clean(selectedValue) &&
        !!item.fieldProvenance[provenanceField]
      );
    const selectedProvenance = selected?.fieldProvenance[provenanceField];
    if (selectedProvenance) {
      fieldProvenance[provenanceField] = selectedProvenance;
      if (
        provenanceField !== "client_email" &&
        selectedProvenance.source === "work_order_pdf_text"
      ) {
        pdfFieldProvenance[provenanceField] = selectedProvenance;
      }
    }
  }
  if (!explicitSuburbItem && identity.siteSuburb) {
    const addressSource = selectedAddressItem?.fieldProvenance.site_address;
    if (addressSource) {
      const suburbSource: DeterministicFieldProvenance = {
        ...addressSource,
        rule: `${DERIVED_SUBURB_RULE_PREFIX}${addressSource.rule}`,
      };
      fieldProvenance.site_suburb = suburbSource;
      if (suburbSource.source === "work_order_pdf_text") {
        pdfFieldProvenance.site_suburb = suburbSource;
      } else {
        delete pdfFieldProvenance.site_suburb;
      }
    }
  }
  return {
    identity,
    conflicts,
    fieldProvenance,
    pdfFieldProvenance,
  };
}

function instructionDiscriminator(item: AdaptedSource): string {
  if (item.intent === "chatter") return `nonwork:${item.source.postId}`;
  if (item.intent === "cancellation") {
    return `cancel:${
      item.identity.builderPoCanonical || item.identity.builderWoCanonical ||
      item.identity.externalRefCanonical || item.source.postId
    }`;
  }
  // An identity-less source keys by document content before transport id: a
  // dual-capture twin pair carrying one uploaded attachment must be one
  // instruction, not one per transport row. Sources with no hashed attachment
  // keep the per-post key.
  const contentIdentity = item.source.attachments
    .filter((a) => a.status === "uploaded" && a.sha256)
    .map((a) => `content:${a.sha256}`)
    .sort()[0] || null;
  // A PO-only key is supporting identity, not permission to erase a source's
  // own reference. Historical po:BOX rows proved why both coordinates are
  // load-bearing: once a component was correlation-bound, choosing only
  // woPoIdentityKey folded every distinct MLB reference into one instruction.
  const strongIdentity = [
    item.identity.externalRefCanonical
      ? `ref:${item.identity.externalRefCanonical}`
      : null,
    item.identity.woPoIdentityKey
      ? `unit:${item.identity.woPoIdentityKey}`
      : null,
  ].filter(Boolean).join("|");
  const identity = strongIdentity || contentIdentity ||
    `source:${item.source.postId}`;
  const base = `${identity}|deliverable:${
    item.identity.deliverableRefCanonical || item.identity.jobFamily
  }`;
  // A revision/reopen is a fresh instruction case in the same lineage, not extra
  // evidence silently folded into the original instruction.
  if (isRevisionSource(item.source)) {
    return `revision:${base}:${item.source.postId}`;
  }
  // D3 (TRACK-A): collection, rectification and "-R" reattendance mail are
  // lifecycle events on the ORIGINAL deliverable — they open a new cycle in the
  // same lineage, never a fresh standalone instruction that could mint again.
  if (isLifecycleReopenText(lifecycleText(item.source))) {
    return `reopen:${base}:${item.source.postId}`;
  }
  return base;
}

function familyReviewOwnershipKeys(
  items: readonly AdaptedSource[],
): Map<AdaptedSource, string> {
  const owners = new Map<AdaptedSource, string>();
  const indexed = items.filter((item) =>
    item.intent === "work" && !isRevisionSource(item.source) &&
    !isLifecycleReopenText(lifecycleText(item.source)) &&
    (item.identity.builderPoCanonical || item.identity.builderWoCanonical)
  );
  const union = new UnionFind(indexed.length);
  const poOwners = new Map<string, number>();
  const woOwners = new Map<string, number[]>();
  for (let index = 0; index < indexed.length; index++) {
    const item = indexed[index];
    const company = item.identity.companyKey || item.identity.builderSlug;
    if (!company) continue;
    if (item.identity.builderPoCanonical) {
      const poKey = `${company}:po:${item.identity.builderPoCanonical}`;
      const prior = poOwners.get(poKey);
      if (prior === undefined) poOwners.set(poKey, index);
      else union.union(index, prior);
    }
    if (item.identity.builderWoCanonical) {
      const woKey = familyReviewWorkOrderKey(item, company);
      woOwners.set(woKey, [...(woOwners.get(woKey) || []), index]);
    }
  }
  for (const ownerIndexes of woOwners.values()) {
    const purchaseOrders = new Set(
      ownerIndexes
        .map((index) => indexed[index].identity.builderPoCanonical)
        .filter(Boolean),
    );
    if (purchaseOrders.size <= 1) {
      for (let index = 1; index < ownerIndexes.length; index++) {
        union.union(ownerIndexes[0], ownerIndexes[index]);
      }
      continue;
    }
    const withoutPo = ownerIndexes.filter((index) =>
      !indexed[index].identity.builderPoCanonical
    );
    for (let index = 1; index < withoutPo.length; index++) {
      union.union(withoutPo[0], withoutPo[index]);
    }
  }
  const componentAliases = new Map<number, Set<string>>();
  for (let index = 0; index < indexed.length; index++) {
    const item = indexed[index];
    const company = item.identity.companyKey || item.identity.builderSlug;
    if (!company) continue;
    const root = union.find(index);
    const values = componentAliases.get(root) || new Set<string>();
    if (item.identity.builderPoCanonical) {
      values.add(`${company}:po:${item.identity.builderPoCanonical}`);
    }
    if (item.identity.builderWoCanonical) {
      values.add(`${company}:wo:${item.identity.builderWoCanonical}`);
    }
    componentAliases.set(root, values);
  }
  for (let index = 0; index < indexed.length; index++) {
    const aliasesForOwner = componentAliases.get(union.find(index));
    if (!aliasesForOwner?.size) continue;
    owners.set(indexed[index], [...aliasesForOwner].sort().join("|"));
  }
  return owners;
}

function familyReviewWorkOrderKey(
  item: AdaptedSource,
  company: string,
): string {
  const workOrder = String(item.identity.builderWoCanonical || "").toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  const purchaseOrder = item.identity.builderPoCanonical?.toUpperCase()
    .replace(/[^A-Z0-9]/g, "") || "";
  // MLB commonly announces the claim-shaped WO first and supplies the PO-bearing
  // PDF later. The PO suffix refines that same WO; it must not make the two
  // sources look unrelated for family-conflict review.
  const root = purchaseOrder && workOrder.endsWith(purchaseOrder)
    ? workOrder.slice(0, -purchaseOrder.length)
    : workOrder;
  return `${company}:wo:${root || workOrder}`;
}

function manifestFor(
  _identity: ExtractedIdentity,
  intent: AdaptedSource["intent"],
): ManifestRequirement[] {
  if (intent === "chatter") {
    return [
      { id: "source_email", required: true, blocking: "none" },
      { id: "non_work_reason", required: true, blocking: "none" },
    ];
  }
  if (intent === "cancellation") {
    return [
      { id: "source_email", required: true, blocking: "none" },
      { id: "external_reference", required: true, blocking: "identity" },
      { id: "cancellation_instruction", required: true, blocking: "none" },
    ];
  }
  return [
    { id: "source_email", required: true, blocking: "identity" },
    { id: "sender_routing", required: true, blocking: "identity" },
    // A dedicated WO remains required for confirmed/blocked live state and for
    // the replay identity floor. Claim-only work stays an exception and can
    // never create a live job without further evidence.
    { id: "builder_work_order", required: true, blocking: "identity" },
    { id: "purchase_order", required: false, blocking: "none" },
    // These fields are required before a new live job can be created, but they
    // are job material rather than the builder instruction's canonical identity.
    // Real MLB messages commonly carry the client only in an image-font PDF;
    // reporting that deterministic extraction gap as an identity mismatch made
    // the replay floor read 0% even when WO/PO/ref identity was present.
    { id: "client_name", required: true, blocking: "live" },
    { id: "site_address", required: true, blocking: "live" },
    { id: "client_phone", required: true, blocking: "secondary" },
    { id: "work_order_attachment", required: true, blocking: "live" },
    // A builder WO PDF is the evidence of record for a live job. Portal links and
    // captures remain observable supporting evidence for report-family follow-up,
    // but neither can park the job before it reaches the canonical board.
    { id: "portal_link", required: false, blocking: "none" },
    { id: "portal_capture", required: false, blocking: "none" },
  ];
}

function buildEvidenceMap(
  manifest: readonly ManifestRequirement[],
  correlated: readonly AdaptedSource[],
): Record<string, EvidenceMapEntry> {
  const allEvidence = correlated.flatMap((item) => item.evidence);
  const searched = correlated.map((item) => item.source.postId).sort();
  const map: Record<string, EvidenceMapEntry> = {};
  for (const requirement of manifest) {
    let evidence = allEvidence.filter((candidate) =>
      candidate.requirement === requirement.id
    );
    if (requirement.id === "non_work_reason") {
      evidence = correlated.filter((i) => i.intent === "chatter").map((i) => ({
        requirement: requirement.id,
        sourcePostId: i.source.postId,
        kind: "message" as const,
        locator: `classifier:chatter:${i.source.postId}`,
        strength: "explicit" as const,
      }));
    }
    if (requirement.id === "cancellation_instruction") {
      evidence = correlated.filter((i) => i.intent === "cancellation").map((
        i,
      ) => ({
        requirement: requirement.id,
        sourcePostId: i.source.postId,
        kind: "message" as const,
        locator: `classifier:cancellation:${i.source.postId}`,
        strength: "explicit" as const,
      }));
    }
    if (
      requirement.id === "portal_capture" &&
      allEvidence.some((e) => e.requirement === "portal_link")
    ) {
      map[requirement.id] = {
        requirement: requirement.id,
        required: requirement.required,
        status: "recovery_staged",
        evidence: allEvidence.filter((e) => e.requirement === "portal_link"),
        searchedSourcePostIds: searched,
        rejectedCandidateLocators: [],
        nextRecoveryAction:
          "capture_portal_evidence_headless_with_idempotency_key",
      };
      continue;
    }
    map[requirement.id] = {
      requirement: requirement.id,
      required: requirement.required,
      status: evidence.length ? "satisfied" : "missing",
      evidence,
      searchedSourcePostIds: searched,
      rejectedCandidateLocators: [],
      nextRecoveryAction: evidence.length || !requirement.required
        ? null
        : `recover_${requirement.id}_case_wide`,
    };
  }
  return map;
}

function stableHash(value: string): string {
  // FNV-1a 64-bit, represented without BigInt to stay portable in edge/test
  // runtimes. This identifies plans/artifacts, while DB uniqueness remains the
  // final concurrency authority.
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ (c >>> 8), 0x01000193);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, "0")}${
    (h2 >>> 0).toString(16).padStart(8, "0")
  }`;
}

function dedupeStory(items: readonly AdaptedSource[]): StoryEvent[] {
  const map = new Map<string, StoryEvent>();
  for (const event of items.flatMap((item) => item.story)) {
    map.set(event.key, event);
  }
  return [...map.values()].sort((a, b) =>
    a.occurredAt.localeCompare(b.occurredAt) || a.key.localeCompare(b.key)
  );
}

function sourceRoleOutcome(state: MakesafeCaseState): SourceOutcome {
  if (state === "confirmed_live_job") return "confirmed_canonical_input";
  if (state === "blocked_live_job") return "visible_blocked_with_recovery";
  if (state === "accounted_non_wo") return "accounted_non_work";
  return "reason_coded_exception";
}

export function buildDeterministicIntakePlan(
  sourceItems: readonly DeterministicSourceItem[],
  profiles: readonly DeterministicCompanyProfile[],
): DeterministicIntakePlan {
  const byPost = new Map<string, DeterministicSourceItem>();
  for (const item of sourceItems) {
    if (!item.postId || byPost.has(item.postId)) continue;
    byPost.set(item.postId, { ...item, links: extractLinks(item) });
  }
  const adapted = [...byPost.values()].map((item) =>
    adaptDeterministicSource(item, profiles)
  );
  const union = new UnionFind(adapted.length);
  const keys = adapted.map(correlationKeysFor);
  const indexByPostId = new Map(
    adapted.map((item, index) => [item.source.postId, index]),
  );
  // Explicit thread coordinates union globally: they are authoritative and may
  // legitimately cross builder slugs or reach sources carrying no identity.
  const threadBuckets = new Map<string, number[]>();
  for (let i = 0; i < adapted.length; i++) {
    const item = adapted[i].source;
    for (
      const key of [
        item.threadId ? `thread:${item.threadId}` : null,
        item.conversationId ? `conversation:${item.conversationId}` : null,
        item.internetMessageId ? `message:${item.internetMessageId}` : null,
        // Sha-identical uploaded attachments are the same physical document, so
        // their carriers describe one deliverable regardless of transport id.
        // This is what folds a dual-capture twin (Graph post + mailbox message,
        // which share no thread coordinate) into one cluster even when only one
        // twin's PDF made the extraction budget.
        ...item.attachments
          .filter((a) => a.status === "uploaded" && a.sha256)
          .map((a) => `attachment_sha:${a.sha256}`),
      ]
    ) {
      if (!key) continue;
      const bucket = threadBuckets.get(key);
      if (bucket) bucket.push(i);
      else threadBuckets.set(key, [i]);
    }
    for (
      const postId of [
        item.replyToPostId,
        ...(item.relatedPostIds || []),
        ...(item.siblingPostIds || []),
      ]
    ) {
      if (!postId) continue;
      const other = indexByPostId.get(postId);
      if (other !== undefined) union.union(i, other);
    }
  }
  for (const bucket of threadBuckets.values()) {
    for (let i = 1; i < bucket.length; i++) union.union(bucket[0], bucket[i]);
  }
  // Identity and address correlation both require an equal non-null builder slug,
  // so only same-builder pairs can ever match. Bucketing first keeps the pairwise
  // pass proportional to per-builder volume rather than the whole read window.
  const builderBuckets = new Map<string, number[]>();
  for (let i = 0; i < adapted.length; i++) {
    const slug = keys[i].builderSlug;
    if (!slug) continue;
    const bucket = builderBuckets.get(slug);
    if (bucket) bucket.push(i);
    else builderBuckets.set(slug, [i]);
  }
  for (const bucket of builderBuckets.values()) {
    for (let x = 0; x < bucket.length; x++) {
      for (let y = x + 1; y < bucket.length; y++) {
        const i = bucket[x];
        const j = bucket[y];
        if (union.find(i) === union.find(j)) continue;
        if (
          correlatedWithinBuilder(adapted[i], adapted[j], keys[i], keys[j])
        ) union.union(i, j);
      }
    }
  }
  const clusters = new Map<number, AdaptedSource[]>();
  for (let i = 0; i < adapted.length; i++) {
    const root = union.find(i);
    clusters.set(root, [...(clusters.get(root) || []), adapted[i]]);
  }

  const cases: DeterministicCasePlan[] = [];
  const globallyClassified = new Set<string>();
  for (const clusterItems of clusters.values()) {
    const sortedCluster = [...clusterItems].sort((a, b) =>
      a.source.receivedAt.localeCompare(b.source.receivedAt) ||
      a.source.postId.localeCompare(b.source.postId)
    );
    const clusterStrong = sortedCluster.map((i) =>
      `${i.identity.builderSlug || "unknown"}:${
        i.identity.builderWoCanonical || i.identity.externalRefCanonical ||
        i.source.postId
      }`
    ).sort();
    const clusterKey = `lineage:${stableHash(clusterStrong.join("|"))}`;
    const clusterStory = dedupeStory(sortedCluster);
    const groups = new Map<string, AdaptedSource[]>();
    const familyOwnershipKeys = familyReviewOwnershipKeys(sortedCluster);
    const familyReviewUnits = new Set<string>();
    const ordinaryFamiliesByUnit = new Map<string, Set<string>>();
    for (const item of sortedCluster) {
      if (
        item.intent !== "work" || isRevisionSource(item.source) ||
        isLifecycleReopenText(lifecycleText(item.source))
      ) continue;
      const key = familyOwnershipKeys.get(item);
      if (!key) continue;
      const families = ordinaryFamiliesByUnit.get(key) || new Set<string>();
      families.add(item.identity.jobFamily);
      ordinaryFamiliesByUnit.set(key, families);
    }
    for (const [key, families] of ordinaryFamiliesByUnit) {
      // A source that merely carries an attachment, portal link, or other
      // supporting evidence can be unclassified. It must not turn a known
      // instruction into a family conflict; only contradictory *known*
      // families for one canonical instruction need review.
      const knownFamilies = new Set(
        [...families].filter((family) => family !== "unclassified"),
      );
      if (knownFamilies.size > 1) {
        familyReviewUnits.add(key);
      }
    }
    const strongDiscriminators = sortedCluster
      .filter((item) =>
        item.identity.woPoIdentityKey || item.identity.externalRefCanonical
      )
      .filter((item) =>
        item.intent === "work" && !isRevisionSource(item.source) &&
        !isLifecycleReopenText(lifecycleText(item.source))
      )
      .map(instructionDiscriminator);
    const oneStrongInstruction = new Set(strongDiscriminators).size === 1
      ? strongDiscriminators[0]
      : null;
    for (const item of sortedCluster) {
      let discriminator = instructionDiscriminator(item);
      const familyUnit = familyOwnershipKeys.get(item);
      if (
        familyUnit && familyReviewUnits.has(familyUnit) &&
        item.intent === "work" && !isRevisionSource(item.source) &&
        !isLifecycleReopenText(lifecycleText(item.source))
      ) {
        discriminator = `family-review:${familyUnit}`;
      }
      // A late PDF/link/appointment in an explicit thread often repeats no identity.
      // Recover it into the sole strong instruction only when unambiguous. If two
      // POs/deliverables exist, it remains separate and visible rather than guessed.
      if (
        oneStrongInstruction && item.intent === "work" &&
        !item.identity.woPoIdentityKey && !item.identity.externalRefCanonical &&
        !isRevisionSource(item.source) &&
        !isLifecycleReopenText(lifecycleText(item.source))
      ) discriminator = oneStrongInstruction;
      groups.set(discriminator, [...(groups.get(discriminator) || []), item]);
    }
    // Track A D6 wildcard recovery: an evidence-only work source whose family
    // abstains (the subject never decides family, and its body/PDF carry no
    // family wording) must not fork the instruction it supports. The cluster
    // is already correlation-bound, so when exactly one classified ordinary
    // instruction group exists, the wildcard folds into it; with zero or
    // several candidates it stays separate and visible rather than guessed.
    // Quote requests, revisions and lifecycle reopens keep their own lanes.
    for (const [key, items] of [...groups.entries()]) {
      // deliverableRefCanonical is normalised to upper case, so the wildcard
      // test is case-insensitive.
      if (!/\|deliverable:unclassified$/i.test(key)) continue;
      if (/^(?:reopen:|revision:|cancel:|nonwork:)/.test(key)) continue;
      if (items.some((i) => i.intent !== "work")) continue;
      if (
        items.some((i) =>
          QUOTE_REQUEST_SIGNAL.test(text(i.source)) ||
          isRevisionSource(i.source) ||
          isLifecycleReopenText(lifecycleText(i.source))
        )
      ) continue;
      const targets = [...groups.entries()].filter(
        ([candidate, targetItems]) =>
          candidate !== key &&
          !/^(?:reopen:|revision:|cancel:|nonwork:)/.test(candidate) &&
          /\|deliverable:(?!unclassified$)/i.test(candidate) &&
          // Wildcard recovery may attach identity-less evidence, or evidence
          // carrying the same instruction identity. It must never use family
          // classification to absorb a source whose own reference conflicts
          // with the candidate instruction.
          items.every((source) =>
            targetItems.some((target) =>
              !instructionReferenceConflict(source, target)
            )
          ),
      ).map(([candidate]) => candidate);
      if (targets.length !== 1) continue;
      const merged = [...groups.get(targets[0])!, ...items].sort((a, b) =>
        a.source.receivedAt.localeCompare(b.source.receivedAt) ||
        a.source.postId.localeCompare(b.source.postId)
      );
      groups.set(targets[0], merged);
      groups.delete(key);
    }
    let rootInstructionKey: string | null = null;
    let previousInstructionKey: string | null = null;
    let cycle = 1;
    for (const instructionItems of groups.values()) {
      const merged = bestIdentity(instructionItems);
      const knownInstructionFamilies = new Set(
        instructionItems
          .map((item) => item.identity.jobFamily)
          .filter((family) => family !== "unclassified"),
      );
      if (knownInstructionFamilies.size > 1) {
        merged.identity = { ...merged.identity, jobFamily: "unclassified" };
      } else if (knownInstructionFamilies.size === 1) {
        const [jobFamily] = knownInstructionFamilies;
        merged.identity = { ...merged.identity, jobFamily };
      }
      const intent = instructionItems.some((i) => i.intent === "cancellation")
        ? "cancellation"
        : instructionItems.every((i) => i.intent === "chatter")
        ? "chatter"
        : instructionItems.some((i) => i.intent === "work")
        ? "work"
        : "ambiguous";
      // The case's own story is its instruction's events. The cluster-wide story
      // stays available for case-wide recovery without leaking a sibling
      // instruction's revision/reopen events into this case's lineage or its
      // earliest-event received_at.
      const story = dedupeStory(instructionItems);
      const reopen = instructionItems.some((i) =>
        i.story.some((event) => event.kind === "reopen")
      );
      if (reopen) cycle++;
      const strongFingerprintItems = instructionItems.filter((item) =>
        item.identity.woPoIdentityKey || item.identity.externalRefCanonical
      );
      const fingerprintItems = strongFingerprintItems.length
        ? strongFingerprintItems
        : instructionItems;
      const fingerprintRepresentations = fingerprintItems.map((item) => ({
        adapter: item.adapterId,
        identity: item.identity.woPoIdentityKey ||
          item.identity.externalRefCanonical,
        deliverable: item.identity.deliverableRefCanonical,
        intent: item.intent,
        // Content participates only as a non-reversible digest: changed
        // instructions become revisions, while dual-capture/twin rows with the
        // same content converge without persisting or logging the body.
        contentHash: stableHash(
          `${item.source.subject || ""}\n${item.source.body || ""}`
            .toLowerCase().replace(/\s+/g, " ").trim(),
        ),
        // Attachments are deliberately excluded. Attachment rows sync separately
        // from the post, so a work order PDF that lands after its instruction
        // email would otherwise change the instruction key and fork a second case
        // instead of promoting the existing exception.
      }));
      const fingerprintInput = [...new Map(
        fingerprintRepresentations.map((
          value,
        ) => [JSON.stringify(value), value]),
      ).values()].sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b))
      );
      const instructionFingerprint = stableHash(
        JSON.stringify(fingerprintInput),
      );
      const deliverableDiscriminator = merged.identity.woPoIdentityKey ||
        `${merged.identity.externalRefCanonical || "unknown"}:${
          merged.identity.deliverableRefCanonical || merged.identity.jobFamily
        }`;
      const instructionKey = buildInstructionKey({
        instructionFingerprint,
        deliverableDiscriminator,
        cycle,
      });
      if (!rootInstructionKey) rootInstructionKey = instructionKey;

      const manifest = manifestFor(merged.identity, intent);
      const evidenceMap = buildEvidenceMap(manifest, sortedCluster);
      // Case-wide recovery may discover supporting client evidence on a sibling
      // instruction, but that evidence cannot populate this instruction's canonical
      // identity. Never let an off-case candidate make a null client look live-ready:
      // guarded approval validates the actual canonical field, not the cluster hint.
      if (!merged.identity.clientName && evidenceMap.client_name) {
        const candidateLocators = evidenceMap.client_name.evidence.map((item) =>
          item.locator
        );
        evidenceMap.client_name = {
          ...evidenceMap.client_name,
          status: "missing",
          evidence: [],
          rejectedCandidateLocators: [
            ...evidenceMap.client_name.rejectedCandidateLocators,
            ...candidateLocators,
          ],
          nextRecoveryAction: "extract_client_name_from_selected_instruction",
        };
      }
      const missingIdentity = manifest.filter((r) =>
        r.required && r.blocking === "identity" &&
        evidenceMap[r.id]?.status === "missing"
      ).map((r) => r.id);
      const missingLive = manifest.filter((r) =>
        r.required && r.blocking === "live" &&
        evidenceMap[r.id]?.status !== "satisfied"
      ).map((r) => r.id);
      const missingPortalEvidence: string[] = [];
      const missingParsedLive = missingLive;
      const missingSecondary = manifest.filter((r) =>
        r.required && r.blocking === "secondary" &&
        evidenceMap[r.id]?.status !== "satisfied"
      ).map((r) => r.id);
      const claimOnly = !!merged.identity.externalRefCanonical &&
        !merged.identity.woPoIdentityKey;
      // Track A D4 (Ruling 1): a builder "please price this" request with no
      // work order PDF and no PO is the quote-stage repair lane — a sealed
      // pre-deliverable exception to the WO+PO unit. It files under its own
      // reviewable reason code (mirroring the maybe-box) as a repair-family
      // card the repair manager dispositions; when the real WO+PO arrives the
      // deliverable case forms normally and takes the PDF's declared family.
      const quoteStageRequest = intent === "work" &&
        !instructionItems.some((i) =>
          (i.source.pdfDocuments || []).some((d) =>
            d.status === "extracted" && !!d.text
          )
        ) &&
        !merged.identity.builderPoCanonical &&
        instructionItems.some((i) =>
          QUOTE_REQUEST_SIGNAL.test(text(i.source))
        ) &&
        !instructionItems.some((i) =>
          isLifecycleReopenText(lifecycleText(i.source))
        );
      // Captain ruling 2026-08-31: a properly identified, readable work order
      // that is not general make-safe, not a roof report, not an
      // assessment/quote report and not a temporary fence make-safe IS repair.
      // The complement is computed here but consumed only at the ladder's LAST
      // exception rung, where every quality floor above (chatter, cancellation,
      // unknown builder, quote-stage, conflicting fields, identity floor,
      // parse failure) has already fired. It additionally requires:
      // - every source item genuinely ABSTAINED (`job_family:ambiguous_scope`),
      //   so a restoration park (`text_restoration_park`/`ajs_restoration_park`)
      //   and a cross-source family CONFLICT (whose items carry positive
      //   evidence) both keep parking exactly as today;
      // - a real extracted scope block (a boilerplate-only or unextracted PDF
      //   is not a readable work order);
      // - the settled WO+PO identity key (properly identified).
      const identifiedWoRepair = merged.identity.jobFamily === "unclassified" &&
        instructionItems.every((item) =>
          item.parseWarnings.includes("job_family:ambiguous_scope")
        ) &&
        applyIdentifiedWorkOrderRepairComplement(
          { family: null, evidence: "ambiguous_scope" },
          {
            scopeReadable: instructionItems.some((item) =>
              !!pdfScopeText(item.source, item.adapterId)
            ),
            identityProved: !!merged.identity.woPoIdentityKey,
          },
        ).family === "repair";
      let state: MakesafeCaseState;
      let reasonCode: MakesafeReasonCode | null = null;
      if (intent === "chatter") {
        state = "accounted_non_wo";
        reasonCode = "non_makesafe";
      } else if (intent === "cancellation") {
        state = "exception";
        reasonCode = "cancellation_target_not_found";
      } else if (
        !instructionItems.some((i) =>
          i.adapterId && i.adapterId !== "chatter"
        ) || !merged.identity.companyId
      ) {
        state = "exception";
        reasonCode = "unknown_builder";
      } else if (quoteStageRequest) {
        state = "exception";
        reasonCode = "repair_quote_stage";
        merged.identity = { ...merged.identity, jobFamily: "repair" };
      } else if (Object.keys(merged.conflicts).length) {
        state = "exception";
        reasonCode = "conflicting_fields";
        for (const field of Object.keys(merged.conflicts)) {
          if (evidenceMap[field]) {
            evidenceMap[field] = {
              ...evidenceMap[field],
              status: "ambiguous",
              rejectedCandidateLocators: merged.conflicts[field].map((
                _,
                index,
              ) => `conflict:${field}:${index}`),
              nextRecoveryAction: `human_verify_${field}`,
            };
          }
        }
      } else if (claimOnly || missingIdentity.length) {
        state = "exception";
        // Distinguish "we have a builder WO ref but no WO PDF" from a generic
        // identity shortfall. The former is a reviewable grey area: a human or
        // the AI skill can create the job from the subject + address without
        // waiting for a PDF that may never arrive. The latter is a genuine
        // parse gap.
        const hasWoRef = !!merged.identity.externalRefCanonical ||
          !!merged.identity.builderWoCanonical;
        const hasExtractedPdf = instructionItems.some((i) =>
          (i.source.pdfDocuments || []).some((d) =>
            d.status === "extracted" && !!d.text
          )
        );
        const woAttachmentMissing =
          evidenceMap.work_order_attachment?.status === "missing";
        if (hasWoRef && !hasExtractedPdf && woAttachmentMissing) {
          reasonCode = "wo_ref_without_pdf_pending_review";
        } else {
          reasonCode = "below_identity_floor";
        }
      } else if (missingParsedLive.length) {
        // Ordered before the family check: when parsing/extraction failed the
        // truthful reason is the parse gap — the family is unknown BECAUSE the
        // scope never parsed, not because a parsed scope was ambiguous (D6).
        state = "exception";
        reasonCode = "adapter_parse_failure";
      } else if (
        merged.identity.jobFamily === "unclassified" && !identifiedWoRepair
      ) {
        state = "exception";
        reasonCode = "ambiguous_scope";
      } else if (missingPortalEvidence.length || missingSecondary.length) {
        state = "blocked_live_job";
      } else {
        state = "confirmed_live_job";
      }
      // The complement stamps the family only on a case that actually wants a
      // live job. An earlier rung firing (a chatter-only cluster can still
      // satisfy the complement's own terms) keeps its exception untouched.
      // Precedent for a fate-time family stamp with unchanged instruction and
      // lineage keys: the `repair_quote_stage` rung above.
      if (
        identifiedWoRepair &&
        (state === "blocked_live_job" || state === "confirmed_live_job")
      ) {
        merged.identity = { ...merged.identity, jobFamily: "repair" };
      }

      let relation: DeterministicCasePlan["parentRelation"] = null;
      let parent: string | null = null;
      if (rootInstructionKey !== instructionKey) {
        parent = reopen
          ? previousInstructionKey || rootInstructionKey
          : rootInstructionKey;
        relation = reopen
          ? "reopen_of"
          : intent === "cancellation"
          ? "cancellation_of"
          : instructionItems.some((i) => isRevisionSource(i.source))
          ? "revision_of"
          : "sibling_of";
      }
      const primary = instructionItems[0];
      const sourcePostIds = instructionItems.map((i) => i.source.postId).sort();
      const correlatedSourcePostIds = sortedCluster.map((i) => i.source.postId)
        .sort();
      const blockedReasons = state === "blocked_live_job"
        ? [...missingPortalEvidence, ...missingSecondary].map((field) =>
          `missing:${field}`
        )
        : [];
      const missingFields = [
        ...new Set([...missingIdentity, ...missingLive, ...missingSecondary]),
      ].sort();
      const outcome = sourceRoleOutcome(state);
      const classifications = sourcePostIds.map((postId) => ({
        postId,
        outcome,
        instructionKey,
        reasonCode,
      }));
      for (const c of classifications) globallyClassified.add(c.postId);
      // Dual-capture twins carry the same bytes under two attachment ids; one
      // content hash stages one artifact. Rows without a hash keep per-id keys.
      const pdfKeys = [
        ...new Map(
          instructionItems.flatMap((i) => i.source.attachments)
            .filter((a) =>
              /pdf/i.test(a.contentType || "") || /\.pdf$/i.test(a.name || "")
            ).map((a) => [a.sha256 || a.id, a]),
        ).values(),
      ].map((a) => `pdf:${instructionKey}:${a.id}`);
      const screenshotKeys =
        evidenceMap.portal_capture?.status === "recovery_staged"
          ? [`screenshot:${instructionKey}:portal`]
          : [];
      // One document per content hash: a twin transport row must not double the
      // instruction's PDF evidence. Keep the most-recovered copy so a twin whose
      // extraction was deferred never shadows the extracted one.
      const pdfDocumentRecovery = (document: DeterministicPdfDocument) =>
        document.status === "extracted"
          ? 0
          : document.status === "quarantined"
          ? 1
          : 2;
      const pdfDocumentsByContent = new Map<string, DeterministicPdfDocument>();
      for (
        const document of instructionItems.flatMap((item) =>
          item.source.pdfDocuments || []
        )
      ) {
        const contentKey = document.sha256 || document.attachmentId;
        const existing = pdfDocumentsByContent.get(contentKey);
        if (
          !existing ||
          pdfDocumentRecovery(document) < pdfDocumentRecovery(existing)
        ) {
          pdfDocumentsByContent.set(contentKey, document);
        }
      }
      const pdfDocuments = [...pdfDocumentsByContent.values()];
      cases.push({
        instructionKey,
        instructionFingerprint,
        lineageClusterKey: clusterKey,
        parentInstructionKey: parent,
        parentRelation: relation,
        targetRelation: intent === "cancellation" ? "cancellation_of" : null,
        targetJobId: null,
        cycle,
        adapterId: primary.adapterId,
        adapterVersion: primary.adapterVersion,
        manifestVersion: DETERMINISTIC_MANIFEST_VERSION,
        identity: merged.identity,
        state,
        reasonCode,
        blockedReasons,
        missingFields,
        conflictingFields: merged.conflicts,
        sourcePostIds,
        correlatedSourcePostIds,
        primarySourcePostId: primary.source.postId,
        story,
        correlatedStory: clusterStory,
        evidenceMap,
        sourceClassifications: classifications,
        fieldProvenance: merged.fieldProvenance,
        pdfFieldProvenance: merged.pdfFieldProvenance,
        pdfDocuments,
        recoveryCursor: {
          version: DETERMINISTIC_INTAKE_VERSION,
          completedStages: [
            "adapted",
            "correlated_case_wide",
            "story_built",
            "manifest_searched",
          ],
          nextStage: state === "exception"
            ? "bounded_recovery_or_human_review"
            : "persist_case_and_guarded_job",
          searchedSourcePostIds: correlatedSourcePostIds,
          stagedArtifactKeys: [...pdfKeys, ...screenshotKeys],
          sideEffectKeys: {
            draft: `draft:${instructionKey}`,
            job: `job:${instructionKey}`,
            pdfs: pdfKeys,
            screenshots: screenshotKeys,
            invoices: [],
            outboundMessages: [],
            approvals: [`approval:${instructionKey}`],
          },
        },
      });
      previousInstructionKey = instructionKey;
    }
  }

  // Defensive accounting: any source missed by grouping gets its own visible
  // unknown-builder exception. This should remain unreachable, and is included so
  // zero-unaccounted is a structural property rather than a reporting assertion.
  for (const item of adapted) {
    if (globallyClassified.has(item.source.postId)) continue;
    throw new Error(
      `deterministic intake left source unaccounted: ${item.source.postId}`,
    );
  }
  const sourceClassifications = cases.flatMap((c) => c.sourceClassifications);
  return {
    version: DETERMINISTIC_INTAKE_VERSION,
    aiCalls: 0,
    cases,
    sourceClassifications,
    totals: {
      sources: adapted.length,
      cases: cases.length,
      confirmed:
        sourceClassifications.filter((c) =>
          c.outcome === "confirmed_canonical_input"
        ).length,
      blocked:
        sourceClassifications.filter((c) =>
          c.outcome === "visible_blocked_with_recovery"
        ).length,
      exceptions:
        sourceClassifications.filter((c) =>
          c.outcome === "reason_coded_exception"
        ).length,
      nonWork:
        sourceClassifications.filter((c) => c.outcome === "accounted_non_work")
          .length,
      unaccounted: adapted.length -
        new Set(sourceClassifications.map((c) => c.postId)).size,
    },
  };
}

const QUALITY_FIELDS: readonly DeterministicQualityField[] = [
  "client_name",
  "client_phone",
  "client_email",
  "site_address",
  "site_suburb",
  "external_reference",
  "builder_work_order",
  "purchase_order",
  "description",
] as const;

function percentage(filled: number, total: number): number | null {
  return total === 0 ? null : Math.round((filled / total) * 10_000) / 100;
}

function qualityFieldValue(
  intakeCase: DeterministicCasePlan,
  field: DeterministicQualityField,
): string | null {
  switch (field) {
    case "client_name":
      return intakeCase.identity.clientName;
    case "client_phone":
      return intakeCase.identity.clientPhone;
    case "client_email":
      return intakeCase.identity.clientEmail;
    case "site_address":
      return intakeCase.identity.siteAddress;
    case "site_suburb":
      return intakeCase.identity.siteSuburb;
    case "external_reference":
      return intakeCase.identity.externalRefCanonical;
    case "builder_work_order":
      return intakeCase.identity.builderWoCanonical;
    case "purchase_order":
      return intakeCase.identity.builderPoCanonical;
    case "description":
      return intakeCase.identity.description;
  }
}

/**
 * Pure, repeatable quality measurement. Callers can build a plan from a
 * read-only source/PDF snapshot and compare the result without advancing the
 * scan cursor or writing any production row.
 */
export function measureDeterministicIntakeQuality(
  plan: DeterministicIntakePlan,
): DeterministicIntakeQualityMeasure {
  const instructions = plan.cases.filter((intakeCase) =>
    intakeCase.state !== "accounted_non_wo"
  );
  const byBuilder: Record<string, DeterministicBuilderQualityMeasure> = {};
  for (const intakeCase of instructions) {
    const builder = intakeCase.identity.builderSlug || "unknown";
    const measure = byBuilder[builder] ||= {
      instructions: 0,
      confirmed_without_human: 0,
      blocked_live_job: 0,
      reason_coded_exception: 0,
      fields: Object.fromEntries(
        QUALITY_FIELDS.map((field) => [
          field,
          { filled: 0, total: 0, percentage: null },
        ]),
      ) as Record<
        DeterministicQualityField,
        DeterministicQualityFieldMeasure
      >,
    };
    measure.instructions++;
    if (intakeCase.state === "confirmed_live_job") {
      measure.confirmed_without_human++;
    } else if (intakeCase.state === "blocked_live_job") {
      measure.blocked_live_job++;
    } else {
      measure.reason_coded_exception++;
    }
    for (const field of QUALITY_FIELDS) {
      const fieldMeasure = measure.fields[field];
      fieldMeasure.total++;
      if (clean(qualityFieldValue(intakeCase, field))) fieldMeasure.filled++;
    }
  }
  for (const measure of Object.values(byBuilder)) {
    for (const field of QUALITY_FIELDS) {
      const fieldMeasure = measure.fields[field];
      fieldMeasure.percentage = percentage(
        fieldMeasure.filled,
        fieldMeasure.total,
      );
    }
  }
  const confirmed =
    instructions.filter((intakeCase) =>
      intakeCase.state === "confirmed_live_job"
    ).length;
  return {
    version: DETERMINISTIC_INTAKE_VERSION,
    unit: "canonical_instruction",
    instructions: instructions.length,
    confirmed_without_human: confirmed,
    confirmed_without_human_percentage: percentage(
      confirmed,
      instructions.length,
    ),
    by_builder: byBuilder,
  };
}

export function selectIntakeMode(value: unknown): "legacy" | "deterministic" {
  // Compatibility parser only. Standing execution no longer branches on this
  // column; unknown/old values must never revive the retired paid-AI path.
  return value === "legacy" ? "legacy" : "deterministic";
}

export function deterministicModeAllowsAiFallback(): false {
  return false;
}
