/**
 * Executable reader for the canonical MakeSafe materials rate card.
 *
 * Rates live only in `references/materials-rate-card.md`. This module contains
 * parsing and composition rules, but deliberately carries no price literals.
 * The checked-in markdown is an exact copy of the wiki skill's canonical file
 * and is bundled as an ops-api static file for deterministic Edge deploys.
 */

export const SES_MATERIALS_RATE_CARD_PATH =
  "references/materials-rate-card.md" as const;

export const SES_MATERIALS_RATE_CARD_SOURCE =
  "secureworks-wiki/harness/ops/skills/secureworks-makesafe-reporting/references/materials-rate-card.md" as const;

export const SES_MATERIALS_RATE_CARD_MARKDOWN = Deno.readTextFileSync(
  new URL(`./${SES_MATERIALS_RATE_CARD_PATH}`, import.meta.url),
);

export interface SesRateCardMaterialFact {
  label: string;
  quantity: number | null;
  unit: string | null;
}

export interface SesRateCardSettledLine {
  description: string;
  quantity: number;
  unit_price_ex_gst: number;
}

export interface SesRateCardProposal {
  kind: "proposal";
  description: string;
  amount_ex_gst: number;
  raw_amount_ex_gst: number;
  materials: SesRateCardMaterialFact[];
  rate_card_keys: string[];
  provenance: Record<string, unknown>;
}

export type SesRateCardPricing =
  | {
    kind: "settled";
    lines: SesRateCardSettledLine[];
    materials: SesRateCardMaterialFact[];
  }
  | SesRateCardProposal
  | {
    kind: "unquantified";
    materials: SesRateCardMaterialFact[];
  };

interface ParsedRateCard {
  starPicket: number;
  consumablesStandard: number;
  consumablesLarge: number;
  flashingTape: number;
  silicone: number;
  tarpBands: Array<{ upToSquareMetres: number; amount: number }>;
  proposalBasketFloor: number;
  roundMultiple: number;
}

function headingSection(markdown: string, heading: string): string {
  const escaped = heading.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = markdown.match(
    new RegExp(
      `^## ${escaped}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`,
      "m",
    ),
  );
  if (!match) {
    throw new Error(`materials rate card section missing: ${heading}`);
  }
  return match[1];
}

function requiredMoney(text: string, pattern: RegExp, label: string): number {
  const match = text.match(pattern);
  const amount = match ? Number(match[1]) : NaN;
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`materials rate card amount missing: ${label}`);
  }
  return amount;
}

function parseRateCard(markdown: string): ParsedRateCard {
  const pickets = headingSection(markdown, "Star pickets");
  const consumables = headingSection(
    markdown,
    "Cable ties and small consumables",
  );
  const tape = headingSection(markdown, "Flashing tape");
  const silicone = headingSection(markdown, "Sikaflex / silicone");
  const tarp = headingSection(markdown, "Make-safe tarpaulin");
  const unpriced = headingSection(
    markdown,
    "Unpriced in v1 — deliberately, with the reason",
  );
  const styling = headingSection(
    markdown,
    "Line-amount styling: materials amounts end in a non-round number",
  );

  const tarpBands = [...tarp.matchAll(
    /^\| (?:Small|Medium|Large|Extra large)[^|]*\|\s*([0-9.]+)\s*m²[^|]*\|[^|]*\|\s*\$([0-9.]+)\s*\|\s*SETTLED\s*\|/gm,
  )].map((match) => ({
    upToSquareMetres: Number(match[1]),
    amount: Number(match[2]),
  })).filter((band) =>
    Number.isFinite(band.upToSquareMetres) && band.upToSquareMetres > 0 &&
    Number.isFinite(band.amount) && band.amount > 0
  ).sort((a, b) => a.upToSquareMetres - b.upToSquareMetres);
  if (tarpBands.length < 4) {
    throw new Error("materials rate card settled tarp bands missing");
  }

  const basketRow =
    unpriced.split("\n").find((line) =>
      line.includes('**Bundled "materials" / "materials and fixings" lines**')
    ) || "";
  const basketFigures = [...basketRow.matchAll(/\$([0-9.]+)/g)]
    .map((match) => Number(match[1]))
    .filter((amount) => Number.isFinite(amount) && amount > 0);
  if (!basketFigures.length) {
    throw new Error("materials rate card accepted basket figures missing");
  }

  return {
    starPicket: requiredMoney(
      pickets,
      /\| Star pickets supplied \| each \| \$([0-9.]+)/,
      "star picket",
    ),
    consumablesStandard: requiredMoney(
      consumables,
      /\| 1 \(floor\) \| standard job \| \$([0-9.]+)/,
      "standard consumables",
    ),
    consumablesLarge: requiredMoney(
      consumables,
      /\| 2 \| large \/ awkward \/ multi-area job, stated on the line \| \$([0-9.]+)/,
      "large consumables",
    ),
    flashingTape: requiredMoney(
      tape,
      /\| 1 \(floor\) \| one roll, part or whole \| \$([0-9.]+)/,
      "flashing tape",
    ),
    silicone: requiredMoney(
      silicone,
      /\| 1 \(floor\) \| one cartridge, part or whole \| \$([0-9.]+)/,
      "silicone",
    ),
    tarpBands,
    // F29 uses the smallest accepted basket figure as a REVIEW-ONLY proposal
    // floor where the card records no settled item rate. It is never described
    // as settled and cannot pass the later release caveat without Captain review.
    proposalBasketFloor: Math.min(...basketFigures),
    roundMultiple: requiredMoney(
      styling,
      /multiple of\s+`?\$?([0-9.]+)/i,
      "non-round multiple",
    ),
  };
}

let parsedRateCard: ParsedRateCard | null = null;

export function readSesMaterialsRateCard(): ParsedRateCard {
  parsedRateCard ??= parseRateCard(SES_MATERIALS_RATE_CARD_MARKDOWN);
  return parsedRateCard;
}

function positive(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function materialLabel(value: unknown): string {
  if (typeof value === "string") return value.replaceAll(/\s+/g, " ").trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const row = value as Record<string, unknown>;
  for (const key of ["description", "label", "name", "material", "key"]) {
    const label = typeof row[key] === "string"
      ? String(row[key]).replaceAll(/_+/g, " ").replaceAll(/\s+/g, " ").trim()
      : "";
    if (label) return label;
  }
  return "";
}

const QUANTITY_RE =
  /(?:\b(?:x|×)\s*([0-9]+(?:\.[0-9]+)?)\s*(m2|m²|sqm|square metres?|m|metres?|meters?|rolls?|cartridges?|tubes?|panels?|pickets?|clips?|nails?|screws?|fans?|units?|each)?\b)|(?:\b([0-9]+(?:\.[0-9]+)?)\s*(m2|m²|sqm|square metres?|metres?|meters?|rolls?|cartridges?|tubes?|panels?|pickets?|clips?|nails?|screws?|fans?|units?|each)\b)/i;

function factFromMaterial(value: unknown): SesRateCardMaterialFact | null {
  const label = materialLabel(value);
  if (!label) return null;
  const row = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const explicit = positive(row.quantity ?? row.qty ?? row.count ?? row.amount);
  const match = label.match(QUANTITY_RE);
  const parsedQuantity = explicit ?? positive(match?.[1] ?? match?.[3]);
  const quantity = parsedQuantity ??
    (isSilicone(label) || isFlashingTape(label) ? 1 : null);
  const explicitUnit = typeof row.unit === "string" ? row.unit.trim() : "";
  return {
    label,
    quantity,
    unit: explicitUnit || match?.[2] || match?.[4] || null,
  };
}

export function extractSesRateCardMaterialFacts(
  materialsUsed: unknown,
): SesRateCardMaterialFact[] {
  const raw = Array.isArray(materialsUsed) ? materialsUsed : [materialsUsed];
  return raw.map(factFromMaterial).filter(
    (fact): fact is SesRateCardMaterialFact => fact !== null,
  );
}

function isSilicone(label: string): boolean {
  return /\b(?:sikaflex|silicone)(?: sealant)?\b/i.test(label) &&
    !/\bsilicone spray\b/i.test(label);
}

function isFlashingTape(label: string): boolean {
  return /\bflashing[ -]+tape\b/i.test(label);
}

function isAreaUnit(unit: string | null): boolean {
  return /^(?:m2|m²|sqm|square metres?)$/i.test(String(unit || ""));
}

function styleProposalAmount(amount: number, multiple: number): number {
  let candidate = Math.ceil(amount - Number.EPSILON);
  while (candidate % multiple === 0) candidate += 1;
  return candidate;
}

function quantityForWholeUnits(fact: SesRateCardMaterialFact): number {
  return Math.max(1, Math.ceil(fact.quantity || 0));
}

/**
 * Price the trade's recorded quantities from the markdown card.
 *
 * Silicone/tape retain their settled per-unit behavior. Every other executable
 * composition is one explicitly labelled review proposal, styled upward to a
 * non-round amount and paired with a release caveat by the caller.
 */
export function priceRecordedMaterialsFromRateCard(
  materialsUsed: unknown,
): SesRateCardPricing {
  const facts = extractSesRateCardMaterialFacts(materialsUsed);
  if (!facts.length || facts.some((fact) => fact.quantity === null)) {
    return { kind: "unquantified", materials: facts };
  }

  const card = readSesMaterialsRateCard();
  const settledOnly = facts.every((fact) =>
    isSilicone(fact.label) || isFlashingTape(fact.label)
  );
  if (settledOnly) {
    return {
      kind: "settled",
      materials: facts,
      lines: facts.map((fact) => {
        const silicone = isSilicone(fact.label);
        return {
          description: `Materials used: ${fact.label} (${
            silicone ? "whole cartridge" : "whole roll"
          })`,
          quantity: quantityForWholeUnits(fact),
          unit_price_ex_gst: silicone ? card.silicone : card.flashingTape,
        };
      }),
    };
  }

  const components: number[] = [];
  const rateCardKeys = new Set<string>();
  let consumablesAdded = false;
  let unmatchedQuantified = false;
  for (const fact of facts) {
    const label = fact.label;
    if (isSilicone(label)) {
      components.push(card.silicone * quantityForWholeUnits(fact));
      rateCardKeys.add("sikaflex_silicone");
      continue;
    }
    if (isFlashingTape(label)) {
      components.push(card.flashingTape * quantityForWholeUnits(fact));
      rateCardKeys.add("flashing_tape");
      continue;
    }
    if (/\b(?:make-safe )?tarps?|tarpaulins?\b/i.test(label)) {
      if (
        !isAreaUnit(fact.unit) ||
        /\b(?:heavy|xtreme|polyweave|film)\b/i.test(label)
      ) {
        unmatchedQuantified = true;
        continue;
      }
      const band = card.tarpBands.find((candidate) =>
        (fact.quantity || 0) <= candidate.upToSquareMetres
      );
      if (!band) {
        unmatchedQuantified = true;
        continue;
      }
      components.push(band.amount);
      rateCardKeys.add("tarpaulin");
      continue;
    }
    if (/\bstar(?:[\W_]+)?pickets?\b/i.test(label)) {
      components.push(card.starPicket * (fact.quantity || 0));
      rateCardKeys.add("star_picket");
      continue;
    }
    if (
      /\b(?:cable ties?|clips?|nails?|screws?|fixings?|small consumables?)\b/i
        .test(label)
    ) {
      if (!consumablesAdded) {
        components.push(
          /\b(?:large|awkward|multi-area)\b/i.test(label)
            ? card.consumablesLarge
            : card.consumablesStandard,
        );
        rateCardKeys.add("cable_ties_consumables");
        consumablesAdded = true;
      }
      continue;
    }
    unmatchedQuantified = true;
  }

  if (unmatchedQuantified) {
    components.push(card.proposalBasketFloor);
    rateCardKeys.add("accepted_materials_basket_floor");
  }
  if (!components.length) return { kind: "unquantified", materials: facts };

  const rawAmount = Math.round(
    components.reduce((sum, amount) => sum + amount, 0) * 100,
  ) / 100;
  const styledAmount = styleProposalAmount(rawAmount, card.roundMultiple);
  const listed = facts.map((fact) => fact.label).join("; ");
  return {
    kind: "proposal",
    description:
      `Proposed materials for Captain review: ${listed} (rate-card composition; non-round styled total)`,
    amount_ex_gst: styledAmount,
    raw_amount_ex_gst: rawAmount,
    materials: facts,
    rate_card_keys: [...rateCardKeys],
    provenance: {
      source: "materials_rate_card_review_proposal",
      source_path: SES_MATERIALS_RATE_CARD_SOURCE,
      rate_card_keys: [...rateCardKeys],
      raw_amount_ex_gst: rawAmount,
      styled_amount_ex_gst: styledAmount,
      estimate: true,
      captain_review_required: true,
      quantities: facts,
    },
  };
}
