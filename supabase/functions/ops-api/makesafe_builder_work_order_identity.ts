// deno-lint-ignore-file no-explicit-any
export interface BuilderWorkOrderIdentityInput {
  externalRef?: string | null;
  subject?: string | null;
  bodyText?: string | null;
  attachmentNames?: Array<string | null | undefined>;
}

export interface BuilderWorkOrderIdentity {
  builder_claim_ref: string | null;
  builder_work_order_number: string | null;
  builder_po_number: string | null;
  evidence_sources: string[];
}

// ABJR is a live-mail typo of AJBR (Track A D7): both spellings are read and
// canonicalClaim collapses them onto the one AJBR identity.
const BUILDER_REF_WITH_PO_RE =
  /(?<![A-Z0-9])(AJBR|ABJR|AJS|MLB|BWCWA|BWC|WB|KBA)[-\s#]*(\d{3,})\s*(?:[-_\s]*)?P\s*O\s*[-_\s#]*(\d{3,})(?![A-Z0-9])/i;
const BUILDER_REF_RE =
  /(?<![A-Z0-9])(AJBR|ABJR|AJS|MLB|BWCWA|BWC|WB|KBA)[-\s#]*(\d{3,})(?![A-Z0-9])/i;
/**
 * The PO label this module can read, as a source pattern. Exported so downstream
 * identity matching derives the SAME grammar instead of keeping a second copy:
 * a downstream regex that reads a spelling this one cannot would produce a PO
 * token while the canonical PO stays null, leaving PO-separation guards blind.
 */
export const PO_LABEL_PATTERN = "(?:P\\s*O|purchase\\s+order)";
/**
 * Every PO-shaped label, including the dotted and unspaced spellings PO_RE cannot
 * read. Strictly a superset of PO_LABEL_PATTERN, so the two together partition
 * PO-labelled text into "parseable" and "present but unknown".
 */
const LOOSE_PO_LABEL_PATTERN = "(?:p\\s*[./]?\\s*o\\s*\\.?|purchase\\s*order)";
/**
 * A bare, explicitly numbered "Order No <digits>" label. It is NOT a purchase order:
 * builders use it for their own work-order reference as often as for a PO, so reading
 * it as PO doubt would strand the whole archetype as permanently unaccountable — it
 * would carry poUnparsed forever while yielding no identity token to match on. It is
 * instead read downstream as a generic, sender-scoped work-order reference, alongside
 * the "work order" spelling. The explicit number requirement keeps prose like "in
 * order to lay 250 metres" out.
 */
export const ORDER_LABEL_PATTERN = "order\\s*(?:number|no\\.?|#)";
const PO_TAIL_PATTERN = "(?:\\s*(?:number|no\\.?))?\\s*[:#-]?\\s*";

const PO_RE = new RegExp(
  `\\b${PO_LABEL_PATTERN}${PO_TAIL_PATTERN}(\\d{3,})\\b`,
  "i",
);
const LOOSE_PO_RE = new RegExp(
  `\\b(?:${LOOSE_PO_LABEL_PATTERN})${PO_TAIL_PATTERN}\\d{3,}\\b`,
  "i",
);
/**
 * True when the text names a PO in a spelling the canonical grammar cannot parse,
 * so the PO is unknown rather than absent. "P.O. Box 1234" does not qualify: the
 * number does not follow the label directly.
 */
export function hasUnparseablePoLabel(text: string): boolean {
  if (PO_RE.test(text)) return false;
  return LOOSE_PO_RE.test(text);
}

/**
 * True when the text names a PO at all, in any spelling either grammar recognises.
 * Callers reading text that may quote another instruction use this to know a PO is
 * being discussed without adopting its number as their own identity.
 */
export function hasAnyPoLabel(text: string): boolean {
  return PO_RE.test(text) || LOOSE_PO_RE.test(text);
}

/**
 * Filenames separate their words with underscores, and `_` is a word character,
 * so `\b` never fires around a token wedged between them: the PO in
 * `work_order_PO20877_Secure_Works_WA.pdf` is invisible to PO_RE while the same
 * name spelled with spaces parses. Sealed deliverable BWCWA6781 replayed as
 * below_identity_floor for exactly that reason (fixture:
 * makesafe_bwcwa6781_filename_po_fixture_test.ts).
 *
 * The fix is deliberately scoped to attachment NAMES rather than relaxing the
 * PO_RE boundaries globally: the verified Track A replay fates were computed
 * under the current matching behaviour, so a grammar-wide change could shift
 * outcomes beyond the one sealed row without revalidation. Underscores inside
 * body or PDF text therefore still do NOT separate a PO token — see the
 * body-text case in the fixture test, which pins that boundary.
 */
function attachmentNameScanText(name: string): string {
  return name.replace(/_/g, " ");
}

function canonicalClaim(prefix: string, digits: string): string {
  const canonical = prefix.toUpperCase() === "ABJR"
    ? "AJBR"
    : prefix.toUpperCase();
  return `${canonical}-${digits}`;
}

// Ruling 13 (sealed 2026-07-30): real AJ refs carry 5+ digits (67xxx-70xxx).
// A short digit run after AJBR/ABJR ("ABJR 1234") is junk, never an identity.
function isJunkBuilderRef(prefix: string, digits: string): boolean {
  return /^A[JB][BJ]R$/i.test(prefix) && digits.length < 5;
}

function canonicalPo(digits: string): string {
  return `PO-${digits}`;
}

function canonicalWorkOrder(
  prefix: string,
  digits: string,
  poDigits: string,
): string {
  return `${canonicalClaim(prefix, digits)}${canonicalPo(poDigits)}`;
}

function addSource(sources: string[], source: string): void {
  if (!sources.includes(source)) sources.push(source);
}

function normaliseRef(value: string | null | undefined): string {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function scanText(
  text: string,
  source: string,
  current: BuilderWorkOrderIdentity,
): void {
  const full = text.match(BUILDER_REF_WITH_PO_RE);
  if (full && !isJunkBuilderRef(full[1], full[2])) {
    current.builder_claim_ref = current.builder_claim_ref ||
      canonicalClaim(full[1], full[2]);
    current.builder_po_number = current.builder_po_number ||
      canonicalPo(full[3]);
    current.builder_work_order_number = current.builder_work_order_number ||
      canonicalWorkOrder(full[1], full[2], full[3]);
    addSource(current.evidence_sources, source);
    return;
  }

  const claim = text.match(BUILDER_REF_RE);
  if (claim && !isJunkBuilderRef(claim[1], claim[2])) {
    current.builder_claim_ref = current.builder_claim_ref ||
      canonicalClaim(claim[1], claim[2]);
    addSource(current.evidence_sources, source);
  }

  const po = text.match(PO_RE);
  if (po) {
    current.builder_po_number = current.builder_po_number || canonicalPo(po[1]);
    addSource(current.evidence_sources, source);
  }

  if (
    current.builder_claim_ref &&
    current.builder_po_number &&
    !current.builder_work_order_number
  ) {
    current.builder_work_order_number =
      `${current.builder_claim_ref}${current.builder_po_number}`;
  }
}

/**
 * The literal builder reference substring as the source wrote it, before any
 * canonicalisation. Shares the builder prefix vocabulary with the extractor so a
 * new prefix cannot be recognised by one and missed by the other.
 */
export function matchBuilderRefText(
  value: string | null | undefined,
): string | null {
  const text = String(value || "");
  return text.match(BUILDER_REF_WITH_PO_RE)?.[0] ||
    text.match(BUILDER_REF_RE)?.[0] || null;
}

export function extractBuilderWorkOrderIdentity(
  input: BuilderWorkOrderIdentityInput,
): BuilderWorkOrderIdentity {
  const result: BuilderWorkOrderIdentity = {
    builder_claim_ref: null,
    builder_work_order_number: null,
    builder_po_number: null,
    evidence_sources: [],
  };

  if (input.externalRef) scanText(input.externalRef, "external_ref", result);

  // Track A D6 (standing rule + Ruling 5): the subject line never ANCHORS
  // identity. The attachment filename (charter S0) and the labelled body/PDF
  // rows are the anchors; the subject is scanned last, so it corroborates or
  // fills a gap but can no longer beat filename/body identity when a reused
  // "NEW WORK ORDER" subject carries a different or partial reference.
  for (const name of input.attachmentNames || []) {
    if (name) scanText(attachmentNameScanText(name), "attachment_name", result);
  }

  if (input.bodyText) {
    const bodyLines = String(input.bodyText).split(/\r?\n/);
    const labelledLines = bodyLines.flatMap((line, index) => {
      if (
        !/work\s*order|works?\s*order|purchase\s+order|\bP\s*O\b|claim|builder\s+ref|our\s+ref|job\s+number/i
          .test(line)
      ) return [];
      // Generated builder PDFs commonly render a label and its value as two text
      // rows. Carry the immediately following row into the same bounded identity
      // scan; the strict builder/PO grammars still decide whether it is evidence.
      return [line, bodyLines[index + 1] || ""];
    }).join("\n");
    if (labelledLines) scanText(labelledLines, "body_text", result);
  }

  if (input.subject) scanText(input.subject, "subject", result);

  return result;
}

export function mergeBuilderWorkOrderIdentity(
  extraction: Record<string, any>,
  identity: BuilderWorkOrderIdentity,
): Record<string, any> {
  const merged = { ...(extraction || {}) };
  if (identity.builder_claim_ref && !merged.builder_claim_ref) {
    merged.builder_claim_ref = identity.builder_claim_ref;
  }
  if (identity.builder_po_number && !merged.builder_po_number) {
    merged.builder_po_number = identity.builder_po_number;
  }
  if (identity.builder_work_order_number && !merged.builder_work_order_number) {
    merged.builder_work_order_number = identity.builder_work_order_number;
  }

  if (
    identity.builder_work_order_number &&
    (!merged.external_ref ||
      normaliseRef(merged.external_ref) ===
        normaliseRef(identity.builder_claim_ref))
  ) {
    merged.external_ref = identity.builder_work_order_number;
    merged.external_ref_source = "deterministic_builder_work_order_identity";
  } else if (!merged.external_ref && identity.builder_claim_ref) {
    merged.external_ref = identity.builder_claim_ref;
    merged.external_ref_source = "deterministic_builder_claim_ref";
  }

  if (identity.evidence_sources.length) {
    merged.builder_work_order_identity_sources = identity.evidence_sources;
  }

  return merged;
}
