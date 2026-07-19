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

const BUILDER_REF_WITH_PO_RE =
  /(?<![A-Z0-9])(AJBR|AJS|MLB|BWCWA|BWC|WB|KBA)[-\s#]*(\d{3,})\s*(?:[-_\s]*)?P\s*O\s*[-_\s#]*(\d{3,})(?![A-Z0-9])/i;
const BUILDER_REF_RE =
  /(?<![A-Z0-9])(AJBR|AJS|MLB|BWCWA|BWC|WB|KBA)[-\s#]*(\d{3,})(?![A-Z0-9])/i;
const PO_RE =
  /\b(?:P\s*O|purchase\s+order)(?:\s*(?:number|no\.?))?\s*[:#-]?\s*(\d{3,})\b/i;

function canonicalClaim(prefix: string, digits: string): string {
  return `${prefix.toUpperCase()}-${digits}`;
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
  if (full) {
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
  if (claim) {
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
  if (input.subject) scanText(input.subject, "subject", result);

  for (const name of input.attachmentNames || []) {
    if (name) scanText(name, "attachment_name", result);
  }

  if (input.bodyText) {
    const labelledLines = String(input.bodyText)
      .split(/\r?\n/)
      .filter((line) =>
        /work\s*order|works?\s*order|purchase\s+order|\bP\s*O\b|claim|builder\s+ref|our\s+ref|job\s+number/i
          .test(line)
      )
      .join("\n");
    if (labelledLines) scanText(labelledLines, "body_text", result);
  }

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
