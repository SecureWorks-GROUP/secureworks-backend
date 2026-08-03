// deno-lint-ignore-file no-explicit-any
export interface BuilderWorkOrderIdentityInput {
  externalRef?: string | null;
  requestingCompanySlug?: string | null;
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
  /(?<![A-Z0-9])(AJBR|ABJR|AJS|MLB(?:[-\s]+(?!PO(?:[-\s#]|$))[A-Z]{2})?|BWCWA|BWC|WB|KBA)[-\s#]*(\d{3,})\s*(?:[-_\s]*)?P\s*O\s*[-_\s#]*(\d{3,})(?![A-Z0-9])/i;
const BUILDER_REF_RE =
  /(?<![A-Z0-9])(AJBR|ABJR|AJS|MLB(?:[-\s]+(?!PO(?:[-\s#]|$))[A-Z]{2})?|BWCWA|BWC|WB|KBA)[-\s#]*(\d{3,})(?![A-Z0-9])/i;
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
 * Approval-grade ambiguity check: remove every canonical PO-bearing match, then
 * reject any loose PO label left behind. Unlike `hasUnparseablePoLabel`, one
 * valid token cannot mask a second unknown token in the same source string.
 */
export function hasUnparseablePoRemainder(text: string): boolean {
  const withoutCanonical = String(text || "")
    .replace(new RegExp(BUILDER_REF_WITH_PO_RE.source, "gi"), " ")
    .replace(new RegExp(PO_RE.source, "gi"), " ");
  return LOOSE_PO_RE.test(withoutCanonical);
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
 * Scan attachment names with underscores treated as word separators. Keep this
 * normalisation filename-scoped: changing PO_RE would alter body/PDF matching
 * and requires replay revalidation. The boundary is pinned by
 * makesafe_bwcwa6781_filename_po_fixture_test.ts and recorded in AGENTS.md.
 */
function attachmentNameScanText(name: string): string {
  return name.replace(/_/g, " ");
}

export interface BuilderAttachmentIdentityTokens {
  builder_claim_refs: string[];
  builder_po_numbers: string[];
}

/**
 * Enumerate every canonical WO/PO token in one attachment name. The ordinary
 * extractor intentionally returns one identity; intake approval uses this
 * stricter cardinality view to refuse a name that contains multiple candidates.
 */
export function builderIdentityTokensInAttachmentName(
  value: string | null | undefined,
): BuilderAttachmentIdentityTokens {
  const scan = attachmentNameScanText(String(value || ""));
  const claimRefs = new Set<string>();
  const purchaseOrders = new Set<string>();
  for (
    const match of scan.matchAll(
      new RegExp(BUILDER_REF_WITH_PO_RE.source, "gi"),
    )
  ) {
    if (isJunkBuilderRef(match[1], match[2])) continue;
    claimRefs.add(canonicalClaim(match[1], match[2]));
    purchaseOrders.add(canonicalPo(match[3]));
  }
  for (
    const match of scan.matchAll(new RegExp(BUILDER_REF_RE.source, "gi"))
  ) {
    if (!isJunkBuilderRef(match[1], match[2])) {
      claimRefs.add(canonicalClaim(match[1], match[2]));
    }
  }
  for (const match of scan.matchAll(new RegExp(PO_RE.source, "gi"))) {
    purchaseOrders.add(canonicalPo(match[1]));
  }
  return {
    builder_claim_refs: [...claimRefs].sort(),
    builder_po_numbers: [...purchaseOrders].sort(),
  };
}

/** Filename-scoped unparseable-PO check with the canonical underscore rule. */
export function attachmentNameHasUnparseablePoLabel(
  value: string | null | undefined,
): boolean {
  return hasUnparseablePoRemainder(
    attachmentNameScanText(String(value || "")),
  );
}

/**
 * Files minted by SecureWorks while creating a card are internal cover sheets,
 * not instructions supplied by a builder. Keep the check filename-scoped and
 * basename-aware so storage URLs cannot turn an internal document into evidence.
 */
export function isSelfGeneratedMakesafeWorkOrder(
  value: string | null | undefined,
): boolean {
  const withoutQuery = String(value || "").split(/[?#]/, 1)[0];
  let decoded = withoutQuery;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    // A malformed storage path cannot satisfy the exact internal filename shape.
  }
  const basename = decoded.split(/[\\/]/).pop() || "";
  return /^work-order-SWMS-\d+\.pdf$/i.test(basename);
}

function canonicalClaim(prefix: string, digits: string): string {
  const normalisedPrefix = prefix.toUpperCase().replace(/[\s#-]+/g, "-")
    .replace(/^-|-$/g, "");
  const canonical = normalisedPrefix === "ABJR" ? "AJBR" : normalisedPrefix;
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

  const bareAjRef = String(input.externalRef || "").trim().match(/^(\d{5,})$/);
  if (
    String(input.requestingCompanySlug || "").trim().toLowerCase() === "aj" &&
    bareAjRef
  ) {
    result.builder_claim_ref = `AJBR-${bareAjRef[1]}`;
    result.builder_work_order_number = `AJBR-${bareAjRef[1]}`;
    addSource(result.evidence_sources, "external_ref");
  }

  if (input.externalRef) scanText(input.externalRef, "external_ref", result);

  // Track A D6 (standing rule + Ruling 5): the subject line never ANCHORS
  // identity. The attachment filename (charter S0) and the labelled body/PDF
  // rows are the anchors; the subject is scanned last, so it corroborates or
  // fills a gap but can no longer beat filename/body identity when a reused
  // "NEW WORK ORDER" subject carries a different or partial reference.
  for (const name of input.attachmentNames || []) {
    if (name && !isSelfGeneratedMakesafeWorkOrder(name)) {
      scanText(attachmentNameScanText(name), "attachment_name", result);
    }
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

/**
 * Builder (company) scope for an instruction key. The purchase-order number is
 * the job grain, and a bare PO string is only unique inside one builder, so the
 * scope is part of the key rather than an assumption around it.
 */
export type BuilderInstructionScope = "AJ" | "MLB" | "BWCWA" | "WB" | "KBA";

/**
 * `makesafe_companies.slug` -> scope. Deliberately a CLOSED map, not a string
 * cast: an unknown slug must yield no scope and therefore no key, never a scope
 * invented from whatever the intake happened to store.
 *
 * `bw` is Builderwest (BWCWA-/PO-20xxx references) and `wb` is Western Building
 * (WB<job>-<instruction>). They are two different builders whose prefixes are
 * near-anagrams — do not collapse them.
 */
const COMPANY_SLUG_SCOPES: Record<string, BuilderInstructionScope> = {
  aj: "AJ",
  mlb: "MLB",
  bw: "BWCWA",
  wb: "WB",
  kba: "KBA",
};

/**
 * Scope from the builder's own reference prefix, which outranks the company
 * slug. The slug is measurably unreliable — production carries a Western
 * Building `WB68792` reference on a card slugged `bw`, and another on a card
 * slugged `kba` — so it is consulted only when the reference carries no prefix
 * at all (Builderwest's bare `PO20919` shape).
 */
export function builderInstructionScope(input: {
  claimRef?: string | null;
  workOrderNumber?: string | null;
  requestingCompanySlug?: string | null;
}): BuilderInstructionScope | null {
  const ref = String(input.claimRef || input.workOrderNumber || "")
    .toUpperCase();
  const prefix = ref.match(/^([A-Z][A-Z-]*?)-?\d/)?.[1] ||
    (/^[A-Z]+$/.test(ref) ? ref : "");
  if (/^A[JB][BJ]R$|^AJS$/.test(prefix)) return "AJ";
  if (/^BWC(WA)?$/.test(prefix)) return "BWCWA";
  // MLB routes work through two-letter business units (MLB-RR, MLB-MW). The
  // unit is a routing label inside one builder, never a separate scope.
  if (/^MLB(-[A-Z]{2})?$/.test(prefix)) return "MLB";
  if (prefix === "WB") return "WB";
  if (prefix === "KBA") return "KBA";
  const slug = String(input.requestingCompanySlug || "").trim().toLowerCase();
  return COMPANY_SLUG_SCOPES[slug] || null;
}

export interface BuilderInstructionKeyOptions {
  /** Consulted only when the reference itself carries no builder prefix. */
  requestingCompanySlug?: string | null;
  /**
   * `makesafe_job_family`. Only `repair` changes the grain — see rule 3 below.
   */
  family?: string | null;
}

/**
 * Canonical one-instruction key, under the captain's 2026-08-02 ruling that
 * **the purchase order is the job** (`data/decisions/2026-08-02-purchase-order-
 * is-the-job-grain.md`). Three grains, in this order:
 *
 * 1. **Builder scope + purchase order** wherever a PO exists. The work order /
 *    claim reference is the GROUP across a family of jobs, so it is provenance
 *    and must never enter the key: one PO carried under two spellings of its
 *    group reference has to produce ONE key, or the twin the gate exists to
 *    prevent walks straight through it.
 * 2. **AJ keys on its job number.** AJ issues no purchase order at all — zero
 *    PO tokens across 130 AJ cards at 2026-08-02 — and only does make-safes, so
 *    the `AJBR` number is one deliverable. The 5-digit floor is Ruling 13.
 * 3. **Repair keys on the work order**, because repair carries no
 *    per-deliverable PO. UNEXERCISED: zero of the 440 board cards carry the
 *    `repair` family, and the ruling itself flags this reading as provisional,
 *    so the branch fires only when a caller states the family.
 *
 * Everything else yields `null` and the gate stands aside. In particular there
 * is NO claim-only fallback for MLB, Builderwest, Western Building or KBA: a
 * bare group reference is not an instruction, and Western Building's references
 * carry a second per-instruction number (`WB69684-178656`) that a claim-only key
 * would silently discard.
 */
export function builderInstructionKey(
  identity: BuilderWorkOrderIdentity,
  options: BuilderInstructionKeyOptions = {},
): string | null {
  const scope = builderInstructionScope({
    claimRef: identity.builder_claim_ref,
    workOrderNumber: identity.builder_work_order_number,
    requestingCompanySlug: options.requestingCompanySlug,
  });
  if (!scope) return null;

  const poDigits = String(identity.builder_po_number || "").match(/(\d{3,})$/);
  if (poDigits) return `${scope}:PO-${poDigits[1]}`;

  const claimDigits = String(
    identity.builder_claim_ref || identity.builder_work_order_number || "",
  ).match(/(\d{3,})$/);
  if (!claimDigits) return null;

  if (scope === "AJ") {
    return claimDigits[1].length >= 5 ? `AJ:JOB-${claimDigits[1]}` : null;
  }
  if (String(options.family || "").trim().toLowerCase() === "repair") {
    return `${scope}:WO-${claimDigits[1]}`;
  }
  return null;
}

/** Read every canonical key already declared by one card, source by source. */
export function builderInstructionKeysForCard(input: {
  requestingCompanySlug?: string | null;
  family?: string | null;
  metadata?: Record<string, any> | null;
  detailExternalRef?: string | null;
  attachmentNames?: Array<string | null | undefined>;
}): string[] {
  const metadata = input.metadata || {};
  const options: BuilderInstructionKeyOptions = {
    requestingCompanySlug: input.requestingCompanySlug,
    family: input.family ?? metadata.makesafe_job_family ?? null,
  };
  const structured = [
    metadata.builder_work_order_number,
    metadata.builder_claim_ref,
    metadata.builder_po_number,
  ].filter(Boolean).join(" ");
  const sourceValues = [
    structured,
    metadata.external_ref,
    input.detailExternalRef,
  ].filter(Boolean);
  const keys = sourceValues.flatMap((externalRef) => {
    const key = builderInstructionKey(
      extractBuilderWorkOrderIdentity({
        externalRef: String(externalRef),
        requestingCompanySlug: input.requestingCompanySlug,
      }),
      options,
    );
    return key ? [key] : [];
  });
  for (const attachmentName of input.attachmentNames || []) {
    if (!attachmentName || isSelfGeneratedMakesafeWorkOrder(attachmentName)) {
      continue;
    }
    const key = builderInstructionKey(
      extractBuilderWorkOrderIdentity({
        requestingCompanySlug: input.requestingCompanySlug,
        attachmentNames: [attachmentName],
      }),
      options,
    );
    if (key) keys.push(key);
  }
  return [...new Set(keys)].sort();
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
