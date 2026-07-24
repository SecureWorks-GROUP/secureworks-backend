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
  classifyMakeSafeJobFamily,
  subjectIsCancellation,
  subjectIsExcludedNonWorkOrder,
  subjectIsKnownBuilderNoise,
  textHasExplicitReportRequest,
} from "./makesafe_intake_gate.ts";
import { canonicalCompanyDedupeKey } from "../_shared/makesafe_refs.ts";
import { extractBuilderWorkOrderIdentity } from "./makesafe_builder_work_order_identity.ts";
import {
  gapFillFromWorkOrderPdf,
  type PdfFieldProvenance,
  type PdfGapFillField,
  type PdfGapFillValues,
} from "./makesafe_pdf_gap_fill.ts";

export const DETERMINISTIC_INTAKE_VERSION =
  "makesafe-deterministic-intake@2026-07-24.v4";
export const DETERMINISTIC_MANIFEST_VERSION = "makesafe-manifest@2026-07-20.v1";

export type AdapterId = "mlb" | "ajs_ajbr" | "prime" | "rapid" | "chatter";
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
}

export interface DeterministicCompanyProfile {
  id: string;
  slug: string;
  name: string;
  senderPatterns: readonly string[];
  parsingRules?: TemplateParsingRules | null;
}

export interface ExtractedIdentity {
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

export interface AdaptedSource {
  source: DeterministicSourceItem;
  adapterId: AdapterId | null;
  adapterVersion: string;
  intent: "work" | "cancellation" | "chatter" | "ambiguous";
  identity: ExtractedIdentity;
  evidence: readonly EvidenceCandidate[];
  story: readonly StoryEvent[];
  parseWarnings: readonly string[];
  pdfFieldProvenance: Readonly<
    Partial<Record<PdfGapFillField, PdfFieldProvenance>>
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
    Partial<Record<PdfGapFillField, PdfFieldProvenance>>
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
const REVISION_SIGNAL =
  /\b(revis(?:ed|ion)|amend(?:ed|ment)|updated\s+(?:work\s+order|scope|instruction)|supersed(?:e|ed))\b/i;
const REOPEN_SIGNAL =
  /\b(re-?attend|reopen|return\s+(?:visit|to\s+site)|attend\s+again)\b/i;
const REPORT_SIGNAL =
  /\b(report|assessment|inspection|quote|quotation|scope\s+of\s+works)\b/i;
const RAPID_SIGNAL = /\brapid(?:\s+repair(?:s)?)?\b/i;
const PRIME_SIGNAL =
  /\bprime(?:eco|\s+ecosystem|\s+notification|\s+portal)?\b/i;
const AJS_SIGNAL = /\b(?:AJBR|AJS)[-\s#]*\d{3,}\b/i;
const MLB_SIGNAL = /\bMLB[-\s#]*\d{3,}\b/i;
// Require an explicit label delimiter/number token. Bare "NEW WORK ORDER
// MLB-123" proves an instruction and claim, but must not silently promote that
// claim to a builder WO identity.
const WO_RE =
  /\b(?:work\s*order|works\s*order|w\s*[./]?\s*o\s*\.?)\s*(?:(?:number|no\.?)\s*[:#-]?|[:#-])\s*([A-Z]{1,10}[\s._#/-]*\d{3,}(?:[._#/-][A-Z0-9]+)*|\d{3,}(?:[._#/-][A-Z0-9]+)*)\b/i;
const JOB_NO_RE =
  /\bjob\s*(?:no\.?|number|#)\s*[:#-]?\s*([A-Z0-9][A-Z0-9._#/-]{2,})\b/i;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE_RE = /(?:\+?61\s*[2-478]|0[2-478])(?:[\s()-]*\d){8}\b/;
const LABELLED_CLIENT_RE =
  /(?:client|insured|customer|home\s*owner|homeowner|policy\s*holder|owner)\s*(?:name)?\s*[:\-]\s*([A-Za-z][A-Za-z'\-. ]{1,80})/i;
const LABELLED_ADDRESS_RE =
  /(?:site\s*address|risk\s*address|property\s*address|address|property|site)\s*[:\-]\s*([^\n\r]{5,120})/i;

function text(item: DeterministicSourceItem): string {
  return `${item.subject || ""}\n${item.body || ""}`;
}

function extractedPdfDocuments(
  item: DeterministicSourceItem,
): DeterministicPdfDocument[] {
  return (item.pdfDocuments || []).filter((document) =>
    document.status === "extracted" && !!document.text
  );
}

function pdfText(item: DeterministicSourceItem): string {
  return extractedPdfDocuments(item).map((document) => document.text).filter(
    Boolean,
  ).join("\n");
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
  const aliases = adapterId === "ajs_ajbr" ? ["ajs-ajbr"] : [adapterId];
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
  const family = adapterId === "mlb" || adapterId === "prime"
    ? hay.match(/\bMLB[-\s#]*(\d{3,})(?:[-\s]*(?:REV|R)\s*([A-Z0-9]+))?\b/i)
    : adapterId === "ajs_ajbr"
    ? hay.match(
      /\b(?:AJBR|AJS)[-\s#]*(\d{3,})(?:[-\s]*(?:REV|R)\s*([A-Z0-9]+))?\b/i,
    )
    : hay.match(
      /\b(?:RAPID|RR)[-\s#]*(\d{3,})(?:[-\s]*(?:REV|R)\s*([A-Z0-9]+))?\b/i,
    );
  const prefix = adapterId === "ajs_ajbr"
    ? "AJBR"
    : adapterId === "rapid"
    ? "RAPID"
    : "MLB";
  const familyExternalRef = family
    ? `${prefix}-${family[1]}${family[2] ? `-${family[2]}` : ""}`
    : null;
  const labelledWo = hay.match(WO_RE)?.[1] || null;
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
    .map((a) => a.name || "")
    .map((name) => name.match(WO_RE)?.[1] || null)
    .find(Boolean) || null;
  const designatedWorkOrder = item.attachments.some((attachment) =>
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
    subject: item.subject,
    bodyText: `${item.body || ""}\n${pdfText(item)}`,
    attachmentNames: item.attachments.map((attachment) => attachment.name),
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

function inferDeliverable(item: DeterministicSourceItem): string {
  const family = classifyMakeSafeJobFamily(item.subject, item.body, null);
  if (REOPEN_SIGNAL.test(text(item))) return `${family}:reopen`;
  if (
    /\bcollect|pick\s*up|retriev/i.test(text(item)) && /fenc/i.test(text(item))
  ) {
    return `${family}:collection`;
  }
  return family;
}

function fieldCandidates(
  item: DeterministicSourceItem,
  profile: DeterministicCompanyProfile | null,
): {
  fields: Record<string, string>;
  provenance: Partial<Record<PdfGapFillField, PdfFieldProvenance>>;
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
  let fields: Record<string, string> = {
    ...(parsed?.fields || {}),
    ...(subjectFields.external_ref
      ? { external_ref: subjectFields.external_ref }
      : {}),
    ...(client ? { client_name: client } : {}),
    ...(address ? { site_address: address } : {}),
    ...(subjectFields.site_suburb
      ? { site_suburb: subjectFields.site_suburb }
      : {}),
    ...(hay.match(PHONE_RE)?.[0]
      ? { client_phone: clean(hay.match(PHONE_RE)?.[0])! }
      : {}),
    ...(hay.match(EMAIL_RE)?.[0]
      ? { client_email: clean(hay.match(EMAIL_RE)?.[0])! }
      : {}),
  };
  const provenance: Partial<
    Record<PdfGapFillField, PdfFieldProvenance>
  > = {};
  const warnings: string[] = [];
  for (const document of extractedPdfDocuments(item)) {
    const result = gapFillFromWorkOrderPdf({
      current: fields as PdfGapFillValues,
      pdfText: document.text,
      extractor: document.extractor || "unknown",
      sourcePostId: item.postId,
      attachmentId: document.attachmentId,
      attachmentName: document.attachmentName,
    });
    fields = { ...fields, ...result.fields } as Record<string, string>;
    Object.assign(provenance, result.provenance);
    warnings.push(...result.warnings);
  }
  return { fields, provenance, warnings };
}

function storyFor(item: DeterministicSourceItem): StoryEvent[] {
  const hay = text(item);
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
  if (
    subjectIsCancellation(item.subject) ||
    /\bcancel(?:led|lation|ling)?\b/i.test(hay)
  ) add("cancellation", "builder_cancelled_instruction");
  else if (REVISION_SIGNAL.test(hay)) {
    add("revision", "builder_revised_instruction");
  } else add("instruction", "builder_instruction_received");
  if (APPOINTMENT_SIGNAL.test(hay)) {
    add("appointment", "appointment_or_attendance_time_received");
  }
  if (ACCESS_SIGNAL.test(hay)) {
    add("access_outcome", "site_access_outcome_received");
  }
  if (REOPEN_SIGNAL.test(hay)) add("reopen", "return_attendance_requested");
  if (REPORT_SIGNAL.test(hay) || textHasExplicitReportRequest(hay)) {
    add("reporting_request", "report_or_quote_requested");
  }
  add("deliverable", `deliverable:${inferDeliverable(item)}`);
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
  pdfFieldProvenance: Readonly<
    Partial<Record<PdfGapFillField, PdfFieldProvenance>>
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
        : requirement as PdfGapFillField;
      const pdfSource = pdfFieldProvenance[provenanceKey];
      out.push({
        requirement,
        sourcePostId: item.postId,
        kind: "field",
        locator: pdfSource
          ? `attachment:${pdfSource.attachmentId}:field:${requirement}`
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
    out.push({
      requirement: pdf ? "work_order_attachment" : "source_attachment",
      sourcePostId: item.postId,
      kind: "attachment",
      locator: `attachment:${attachment.id}`,
      strength: pdf && attachment.status === "uploaded"
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
  const parsed = fieldCandidates(item, profile);
  const fields = parsed.fields;
  const deliverable = inferDeliverable(item);
  const canonical = normaliseMakesafeIdentity({
    externalRefRaw: raw.externalRef || fields.external_ref || null,
    builderWoRaw: raw.wo,
    builderPoRaw: raw.po,
    deliverableRefRaw: deliverable,
    prefixes: ["MLB", "AJBR", "AJS", "RAPID", "RR"],
  });
  const identity: ExtractedIdentity = {
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
    jobFamily: classifyMakeSafeJobFamily(item.subject, item.body, null),
  };
  const hay = text(item);
  const intent = subjectIsCancellation(item.subject) ||
      /\bwork\s+order\s+(?:is\s+)?cancelled\b/i.test(hay)
    ? "cancellation"
    : isChatter(item)
    ? "chatter"
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
    story: storyFor(item),
    parseWarnings: [
      ...(!profile ? ["company_profile_not_resolved"] : []),
      ...(!raw.wo && raw.externalRef ? ["claim_only_identity"] : []),
      ...parsed.warnings,
    ],
    pdfFieldProvenance: parsed.provenance,
  };
}

function blankIdentity(): ExtractedIdentity {
  return {
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
    story: storyFor(item),
    parseWarnings: [],
    pdfFieldProvenance: {},
  }),
};

// Load-bearing order approved by the deterministic intake contract.
export const DETERMINISTIC_ADAPTER_REGISTRY: readonly Adapter[] = Object.freeze(
  [
    MLB_ADAPTER,
    AJS_ADAPTER,
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
      story: storyFor(item),
      parseWarnings: ["own_outbound_copy"],
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
    story: storyFor(item),
    parseWarnings: ["unknown_builder"],
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
  fieldProvenance: Partial<Record<PdfGapFillField, PdfFieldProvenance>>;
} {
  const ordered = [...items].sort((a, b) =>
    a.source.receivedAt.localeCompare(b.source.receivedAt) ||
    a.source.postId.localeCompare(b.source.postId)
  );
  const base = ordered.find((i) => i.identity.builderSlug) || ordered[0];
  const conflicts: Record<string, string[]> = {};
  const preferredItems = (
    identityField: keyof ExtractedIdentity,
    provenanceField: PdfGapFillField,
  ) => {
    const candidates = ordered.filter((item) =>
      clean(item.identity[identityField]) !== null
    );
    const emailDerived = candidates.filter((item) =>
      !item.pdfFieldProvenance[provenanceField]
    );
    return emailDerived.length ? emailDerived : candidates;
  };
  const preferredMerge = (
    identityField: keyof ExtractedIdentity,
    provenanceField: PdfGapFillField,
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
    provenanceField: PdfGapFillField,
  ) =>
    clean(
      preferredItems(identityField, provenanceField)[0]?.identity[
        identityField
      ],
    );
  const client = preferredMerge("clientName", "client_name");
  const phone = preferredMerge("clientPhone", "client_phone");
  const email = mergeField(ordered.map((i) => i.identity.clientEmail));
  const address = preferredMerge("siteAddress", "site_address");
  if (client.conflicts.length) conflicts.client_name = client.conflicts;
  if (phone.conflicts.length) conflicts.client_phone = phone.conflicts;
  if (email.conflicts.length) conflicts.client_email = email.conflicts;
  if (address.conflicts.length) conflicts.site_address = address.conflicts;
  const strong = (field: keyof ExtractedIdentity) => {
    const candidates = ordered.map((i) => i.identity[field]).filter((
      v,
    ): v is string => typeof v === "string" && !!v);
    return candidates[0] || null;
  };
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
    siteSuburb: preferredStrong("siteSuburb", "site_suburb"),
    description: preferredStrong("description", "description"),
    jobFamily: strong("jobFamily") || "general_makesafe",
  };
  const fieldMap: Array<
    [PdfGapFillField, keyof ExtractedIdentity, string | null]
  > = [
    ["client_name", "clientName", identity.clientName],
    ["client_phone", "clientPhone", identity.clientPhone],
    ["site_address", "siteAddress", identity.siteAddress],
    ["site_suburb", "siteSuburb", identity.siteSuburb],
    ["external_ref", "externalRefRaw", identity.externalRefRaw],
    ["description", "description", identity.description],
  ];
  const fieldProvenance: Partial<
    Record<PdfGapFillField, PdfFieldProvenance>
  > = {};
  for (const [provenanceField, identityField, selectedValue] of fieldMap) {
    if (!selectedValue) continue;
    const preferred = preferredItems(identityField, provenanceField);
    const selected = preferred.find((item) =>
      clean(item.identity[identityField]) === clean(selectedValue) &&
      !!item.pdfFieldProvenance[provenanceField]
    );
    if (selected?.pdfFieldProvenance[provenanceField]) {
      fieldProvenance[provenanceField] =
        selected.pdfFieldProvenance[provenanceField];
    }
  }
  return {
    identity,
    conflicts,
    fieldProvenance,
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
  const identity = item.identity.woPoIdentityKey ||
    item.identity.externalRefCanonical || `source:${item.source.postId}`;
  const base = `${identity}|deliverable:${
    item.identity.deliverableRefCanonical || item.identity.jobFamily
  }`;
  // A revision/reopen is a fresh instruction case in the same lineage, not extra
  // evidence silently folded into the original instruction.
  if (REVISION_SIGNAL.test(text(item.source))) {
    return `revision:${base}:${item.source.postId}`;
  }
  if (REOPEN_SIGNAL.test(text(item.source))) {
    return `reopen:${base}:${item.source.postId}`;
  }
  return base;
}

function manifestFor(
  identity: ExtractedIdentity,
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
  const report = identity.jobFamily === "roof_report" ||
    identity.jobFamily === "assessment_report_quote";
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
    { id: "work_order_attachment", required: !report, blocking: "live" },
    { id: "portal_link", required: report, blocking: "live" },
    // A staged capture is not proof the builder portal was completed. Keep the
    // report out of the guarded job/ready-to-invoice path until the capture exists.
    { id: "portal_capture", required: report, blocking: "live" },
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
    const strongDiscriminators = sortedCluster
      .filter((item) =>
        item.identity.woPoIdentityKey || item.identity.externalRefCanonical
      )
      .filter((item) =>
        item.intent === "work" && !REVISION_SIGNAL.test(text(item.source)) &&
        !REOPEN_SIGNAL.test(text(item.source))
      )
      .map(instructionDiscriminator);
    const oneStrongInstruction = new Set(strongDiscriminators).size === 1
      ? strongDiscriminators[0]
      : null;
    for (const item of sortedCluster) {
      let discriminator = instructionDiscriminator(item);
      // A late PDF/link/appointment in an explicit thread often repeats no identity.
      // Recover it into the sole strong instruction only when unambiguous. If two
      // POs/deliverables exist, it remains separate and visible rather than guessed.
      if (
        oneStrongInstruction && item.intent === "work" &&
        !item.identity.woPoIdentityKey && !item.identity.externalRefCanonical &&
        !REVISION_SIGNAL.test(text(item.source)) &&
        !REOPEN_SIGNAL.test(text(item.source))
      ) discriminator = oneStrongInstruction;
      groups.set(discriminator, [...(groups.get(discriminator) || []), item]);
    }
    let rootInstructionKey: string | null = null;
    let previousInstructionKey: string | null = null;
    let cycle = 1;
    for (const instructionItems of groups.values()) {
      const merged = bestIdentity(instructionItems);
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
      const missingSecondary = manifest.filter((r) =>
        r.required && r.blocking === "secondary" &&
        evidenceMap[r.id]?.status !== "satisfied"
      ).map((r) => r.id);
      const claimOnly = !!merged.identity.externalRefCanonical &&
        !merged.identity.woPoIdentityKey;
      let state: MakesafeCaseState;
      let reasonCode: MakesafeReasonCode | null = null;
      if (intent === "chatter") {
        state = "accounted_non_wo";
        reasonCode = "non_makesafe";
      } else if (intent === "cancellation") {
        state = "exception";
        reasonCode = "cancellation";
      } else if (
        !instructionItems.some((i) =>
          i.adapterId && i.adapterId !== "chatter"
        ) || !merged.identity.companyId
      ) {
        state = "exception";
        reasonCode = "unknown_builder";
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
        reasonCode = "below_identity_floor";
      } else if (missingLive.length) {
        state = "exception";
        reasonCode = "adapter_parse_failure";
      } else if (missingSecondary.length) {
        state = "blocked_live_job";
      } else {
        state = "confirmed_live_job";
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
          : instructionItems.some((i) => REVISION_SIGNAL.test(text(i.source)))
          ? "revision_of"
          : "sibling_of";
      }
      const primary = instructionItems[0];
      const sourcePostIds = instructionItems.map((i) => i.source.postId).sort();
      const correlatedSourcePostIds = sortedCluster.map((i) => i.source.postId)
        .sort();
      const blockedReasons = state === "blocked_live_job"
        ? missingSecondary.map((field) => `missing:${field}`)
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
      const pdfKeys = instructionItems.flatMap((i) => i.source.attachments)
        .filter((a) =>
          /pdf/i.test(a.contentType || "") || /\.pdf$/i.test(a.name || "")
        ).map((a) => `pdf:${instructionKey}:${a.id}`);
      const screenshotKeys =
        evidenceMap.portal_capture?.status === "recovery_staged"
          ? [`screenshot:${instructionKey}:portal`]
          : [];
      const pdfDocuments = [...new Map(
        instructionItems.flatMap((item) => item.source.pdfDocuments || []).map(
          (document) => [document.attachmentId, document],
        ),
      ).values()];
      cases.push({
        instructionKey,
        instructionFingerprint,
        lineageClusterKey: clusterKey,
        parentInstructionKey: parent,
        parentRelation: relation,
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

export function selectIntakeMode(value: unknown): "legacy" | "deterministic" {
  // Compatibility parser only. Standing execution no longer branches on this
  // column; unknown/old values must never revive the retired paid-AI path.
  return value === "legacy" ? "legacy" : "deterministic";
}

export function deterministicModeAllowsAiFallback(): false {
  return false;
}
