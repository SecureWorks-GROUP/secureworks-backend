export const AJS_EXISTING_FENCE_STAR_PICKET_RATE_EX_GST = 13.5;

export type ExistingFencePicketRefusal =
  | "genuine_temporary_fence_signal"
  | "existing_fence_scope_missing"
  | "star_picket_quantity_missing_or_ambiguous";

export type ExistingFencePicketDecision =
  | { state: "none" }
  | {
    state: "billable";
    quantity: number;
    material_evidence: string;
    support_evidence: string;
  }
  | { state: "refused"; reason: ExistingFencePicketRefusal };

const STAR_PICKET_RE = /\bstar(?:[\W_]+)?pickets?\b/i;

// Mirrors the wiki's 2026-08-03 carve-out: one narrative must bind a support
// verb to an existing fence within 100 characters, without stitching separate
// fields together into evidence that no source actually states.
const EXISTING_FENCE_SUPPORT_RE = new RegExp(
  String
    .raw`(?:\b(?:prop(?:s|ped|ping)?|support(?:s|ed|ing)?|brac(?:e|es|ed|ing)|stabili[sz](?:e|es|ed|ing)|secur(?:e|es|ed|ing))\b[^.;\n]{0,100}\bexisting(?:\s+[a-z0-9]+){0,3}\s+fenc(?:e|ing)\b|\bexisting(?:\s+[a-z0-9]+){0,3}\s+fenc(?:e|ing)\b[^.;\n]{0,100}\b(?:prop(?:s|ped|ping)?|support(?:s|ed|ing)?|brac(?:e|es|ed|ing)|stabili[sz](?:e|es|ed|ing)|secur(?:e|es|ed|ing))\b)`,
  "i",
);

// Exact mirror of the wiki's global anti-laundering signals. Fixings and
// consumables remain separately refused server lines, but do not erase a valid
// picket carve-out merely because a raw checklist separately mentions them.
// A classified physical make-safe also outranks a trade's free-text temp-fence
// label; concrete kit evidence and a classified temporary-fencing family still
// refuse independently.
const GENUINE_TEMP_FENCE_KIT_SIGNAL_RE =
  /\bpanels?\b|\bblocks?\b|\bbases?\b|\bties?\b|\bclips?\b|\bhire\b|\bretrieval[\s_-]*materials?\b/i;
const TEMPORARY_FENCE_TEXT_SIGNAL_RE = /\b(?:temporary|temp|storm)[\s_-]*fenc/i;
const PICKET_LINE_OTHER_RULED_MATERIAL_RE =
  /\bpanels?\b|\bblocks?\b|\bbases?\b|\bties?\b|\bclips?\b|\bfixings?\b|\bconsumables?\b|\bhire\b|\bretrieval[\s_-]*materials?\b/i;

function text(value: unknown): string {
  return typeof value === "string"
    ? value.replaceAll(/[_-]+/g, " ").trim()
    : "";
}

function positivePicketQuantity(value: string): number | null {
  for (
    const pattern of [
      /\bstar(?:[\W_]+)?pickets?\b\s*(?:x|×|:|-)?\s*(\d+(?:\.\d+)?)/i,
      /(\d+(?:\.\d+)?)\s*(?:x|×)?\s*\bstar(?:[\W_]+)?pickets?\b/i,
    ]
  ) {
    const match = value.match(pattern);
    const quantity = Number(match?.[1]);
    if (Number.isInteger(quantity) && quantity > 0) return quantity;
  }
  return null;
}

function hasExplicitPositiveQuantity(value: string): boolean {
  return /(?:\b\d+(?:\.\d+)?\s*(?:x|×)?\s*\b|(?:x|×|:)\s*\d+(?:\.\d+)?\b)/i
    .test(value);
}

function supportEvidence(narratives: string[]): string | null {
  return narratives.find((narrative) =>
    EXISTING_FENCE_SUPPORT_RE.test(narrative)
  ) || null;
}

export function deriveExistingFencePicketDecision(input: {
  support_narratives: unknown[];
  materials_used: unknown;
  charged_line_descriptions?: unknown[];
  declared_temporary_fence?: boolean;
  classified_family?: "physical_makesafe" | "temporary_fencing";
}): ExistingFencePicketDecision {
  const supportNarratives = input.support_narratives.map(text).filter(Boolean);
  const chargedLines = (input.charged_line_descriptions || []).map(text).filter(
    Boolean,
  );
  const materialsUsed = Array.isArray(input.materials_used)
    ? input.materials_used.map(text).filter(Boolean)
    : [text(input.materials_used)].filter(Boolean);
  const picketMaterials = materialsUsed.filter((entry) =>
    STAR_PICKET_RE.test(entry)
  );
  const picketChargePresent = chargedLines.some((entry) =>
    STAR_PICKET_RE.test(entry)
  );
  if (!picketMaterials.length && !picketChargePresent) return { state: "none" };

  // Template checkbox labels without a quantity are not evidence that the
  // material was consumed. Only explicitly quantified used-material entries
  // join the proposal semantic surface. Charged invoice lines always join it.
  const evidencedMaterialNarratives = materialsUsed.filter(
    hasExplicitPositiveQuantity,
  );
  const semanticNarratives = [
    ...supportNarratives,
    ...evidencedMaterialNarratives,
    ...chargedLines,
  ];
  if (
    input.classified_family === "temporary_fencing" ||
    input.declared_temporary_fence ||
    picketMaterials.some((narrative) =>
      PICKET_LINE_OTHER_RULED_MATERIAL_RE.test(narrative)
    ) ||
    semanticNarratives.some((narrative) =>
      GENUINE_TEMP_FENCE_KIT_SIGNAL_RE.test(narrative)
    ) ||
    (input.classified_family !== "physical_makesafe" &&
      semanticNarratives.some((narrative) =>
        TEMPORARY_FENCE_TEXT_SIGNAL_RE.test(narrative)
      ))
  ) {
    return { state: "refused", reason: "genuine_temporary_fence_signal" };
  }

  const support = supportEvidence(supportNarratives);
  if (!support) {
    return { state: "refused", reason: "existing_fence_scope_missing" };
  }
  const quantities = new Set(
    picketMaterials.map(positivePicketQuantity).filter(
      (value): value is number => value !== null,
    ),
  );
  if (quantities.size !== 1) {
    return {
      state: "refused",
      reason: "star_picket_quantity_missing_or_ambiguous",
    };
  }
  return {
    state: "billable",
    quantity: [...quantities][0],
    material_evidence: picketMaterials.find((entry) =>
      positivePicketQuantity(entry) !== null
    )!,
    support_evidence: support,
  };
}
